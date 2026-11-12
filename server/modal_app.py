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
        from fastapi import FastAPI, Header, HTTPException, Request
        from fastapi.middleware.cors import CORSMiddleware
        import numpy as np
        import wave

        api = FastAPI()
        api.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["POST", "GET"], allow_headers=["*"])
        password = os.environ["KALIL_PASSWORD"]

        @api.get("/health")
        def health():
            return {"ok": True, "model": MODEL, "load_sec": round(self.load_sec, 1)}

        @api.post("/transcribe")
        async def transcribe(request: Request, x_kalil_key: str = Header(default=""), language: str = "he"):
            if x_kalil_key != password:
                raise HTTPException(status_code=401, detail="bad key")
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
            return {"words": words, "audio_sec": round(len(audio) / 16000, 2), "gpu_sec": round(time.time() - t, 2)}

        return api
