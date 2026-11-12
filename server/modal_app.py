"""
Kalil transcription server on Modal.

Hebrew Whisper (ivrit.ai large-v3-turbo, CTranslate2) on a GPU, with word timestamps.
The site sends 16 kHz mono WAV audio (never the video) and gets back words with times.

Deploy:   python -m modal deploy server/modal_app.py
Secret:   python -m modal secret create kalil-auth KALIL_PASSWORD=<password>
"""
import io
import os
import time

import modal

MODEL = "ivrit-ai/whisper-large-v3-turbo-ct2"   # Apache-2.0, by ivrit.ai
MODEL_DIR = "/model"
ALLOWED_ORIGINS = ["https://taltul1989.github.io", "http://localhost:5179", "http://localhost:5178"]


def download_model():
    from huggingface_hub import snapshot_download
    snapshot_download(MODEL, local_dir=MODEL_DIR)


image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04", add_python="3.11")
    .pip_install("faster-whisper==1.1.1", "huggingface_hub[hf_transfer]==0.30.2", "fastapi[standard]==0.115.12", "numpy<2")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    .run_function(download_model)          # המודל נשמר בתוך ה-image: התעוררות מהירה, בלי הורדה
)

app = modal.App("kalil-transcribe", image=image)
# הזמנות: מפתח -> {name, active, limit_min, month, month_sec, total_sec, requests, created, last}
invites = modal.Dict.from_name("kalil-invites", create_if_missing=True)


@app.cls(
    gpu="T4",
    timeout=600,
    scaledown_window=20,                    # נשאר ער 20 שניות אחרי בקשה (בשביל הקטע הבא), ואז נכבה — לא משלמים על המתנה
    max_containers=3,                       # תקרה: לא יותר מ-3 שרתים במקביל
    secrets=[modal.Secret.from_name("kalil-auth")],
)
@modal.concurrent(max_inputs=1)
class Transcriber:
    @modal.enter()
    def load(self):
        from faster_whisper import WhisperModel
        t = time.time()
        self.model = WhisperModel(MODEL_DIR, device="cuda", compute_type="float16")
        self.load_sec = time.time() - t

    @modal.asgi_app()
    def web(self):
        from fastapi import Body, FastAPI, Header, HTTPException, Request
        from fastapi.middleware.cors import CORSMiddleware
        import numpy as np
        import secrets
        import wave

        api = FastAPI()
        api.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["POST", "GET"], allow_headers=["*"])
        password = os.environ["KALIL_PASSWORD"]   # המפתח של המנהלת
        month_now = lambda: time.strftime("%Y-%m")

        async def who(key):
            """מי שולח: 'admin' (המפתח הראשי), 'invite' (קישור הזמנה פעיל), או None"""
            if key and secrets.compare_digest(key, password):
                return {"role": "admin", "name": "מנהלת"}
            if not key or len(key) > 80:
                return None
            inv = await invites.get.aio(key, None)
            if not inv or not inv.get("active"):
                return None
            if inv.get("month") != month_now():      # חודש חדש — המונה מתאפס
                inv["month"], inv["month_sec"] = month_now(), 0.0
            return {"role": "invite", **inv}

        def public(inv, key=None):
            out = {k: inv.get(k) for k in ("name", "active", "limit_min", "created", "last", "requests")}
            out["month_min"] = round((inv.get("month_sec", 0) if inv.get("month") == month_now() else 0) / 60, 1)
            out["total_min"] = round(inv.get("total_sec", 0) / 60, 1)
            if key: out["key"] = key
            return out

        async def need_admin(key):
            u = await who(key)
            if not u or u["role"] != "admin":
                raise HTTPException(status_code=403, detail="admin only")

        @api.get("/health")
        def health():
            return {"ok": True, "model": MODEL, "load_sec": round(self.load_sec, 1)}

        @api.get("/me")
        async def me(x_kalil_key: str = Header(default="")):
            u = await who(x_kalil_key)
            if not u:
                raise HTTPException(status_code=401, detail="bad key")
            if u["role"] == "admin":
                return {"role": "admin", "name": u["name"]}
            return {"role": "invite", **public(u)}

        # ---- ניהול הזמנות (רק למנהלת) ----
        @api.get("/admin/invites")
        async def list_invites(x_kalil_key: str = Header(default="")):
            await need_admin(x_kalil_key)
            items = []
            async for k, v in invites.items.aio():
                items.append(public(v, k))
            items.sort(key=lambda x: x.get("created") or 0, reverse=True)
            return {"invites": items}

        @api.post("/admin/invites")
        async def create_invite(payload: dict = Body(default={}), x_kalil_key: str = Header(default="")):
            await need_admin(x_kalil_key)
            name = str(payload.get("name", "")).strip()[:40] or "ללא שם"
            limit = max(1, min(600, int(payload.get("limit_min", 60) or 60)))
            key = secrets.token_urlsafe(18)
            inv = {"name": name, "active": True, "limit_min": limit, "created": time.time(), "last": None,
                   "requests": 0, "month": month_now(), "month_sec": 0.0, "total_sec": 0.0}
            await invites.put.aio(key, inv)
            return public(inv, key)

        @api.post("/admin/invites/{key}")
        async def update_invite(key: str, payload: dict = Body(default={}), x_kalil_key: str = Header(default="")):
            await need_admin(x_kalil_key)
            inv = await invites.get.aio(key, None)
            if not inv:
                raise HTTPException(status_code=404, detail="no such invite")
            if "active" in payload: inv["active"] = bool(payload["active"])
            if "limit_min" in payload: inv["limit_min"] = max(1, min(600, int(payload["limit_min"])))
            await invites.put.aio(key, inv)
            return public(inv, key)

        @api.post("/transcribe")
        async def transcribe(request: Request, x_kalil_key: str = Header(default=""), language: str = "he"):
            u = await who(x_kalil_key)
            if not u:
                raise HTTPException(status_code=401, detail="bad key")
            if u["role"] == "invite" and u.get("month_sec", 0) / 60 >= u.get("limit_min", 60):
                raise HTTPException(status_code=429, detail="monthly limit reached")
            body = await request.body()
            if len(body) > 60 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="too large")
            with wave.open(io.BytesIO(body)) as w:
                if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
                    raise HTTPException(status_code=400, detail="need 16kHz mono 16-bit wav")
                audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            t = time.time()
            segments, info = self.model.transcribe(
                audio,
                language=None if language == "auto" else language,
                task="transcribe",
                word_timestamps=True,
                vad_filter=True,                 # מדלג על שקט — מהיר יותר ופחות "המצאות"
                beam_size=5,
            )
            words = []
            for seg in segments:
                for wd in (seg.words or []):
                    text = wd.word.strip()
                    if text:
                        words.append({"text": text, "start": round(wd.start, 3), "end": round(wd.end, 3)})
            audio_sec = len(audio) / 16000
            if u["role"] == "invite":                # רושמים שימוש למי שהוזמן
                inv = await invites.get.aio(x_kalil_key, None)
                if inv:
                    if inv.get("month") != month_now():
                        inv["month"], inv["month_sec"] = month_now(), 0.0
                    inv["month_sec"] = inv.get("month_sec", 0.0) + audio_sec
                    inv["total_sec"] = inv.get("total_sec", 0.0) + audio_sec
                    inv["requests"] = inv.get("requests", 0) + 1
                    inv["last"] = time.time()
                    await invites.put.aio(x_kalil_key, inv)
            return {"words": words, "audio_sec": round(audio_sec, 2), "gpu_sec": round(time.time() - t, 2)}

        return api
