// Worker לתמלול מקומי עם Whisper (transformers.js). רץ ברקע כדי שהממשק לא ייתקע.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

// שמירת המודל ב"מערכת הקבצים הפרטית" של הדפדפן (OPFS).
// מטמון הדפדפן הרגיל נכשל בקבצים גדולים (1GB+), ואז המודל היה יורד שוב בכל פעם.
const modelsDir = (async () => (await navigator.storage.getDirectory()).getDirectoryHandle('models', { create: true }))();
const fileName = (key) => String(typeof key === 'string' ? key : key.url).replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
const opfsCache = {
  async match(key) {
    try {
      const dir = await modelsDir;
      const f = await (await dir.getFileHandle(fileName(key))).getFile();
      if (!f.size) return undefined;
      return new Response(f, { headers: { 'content-length': String(f.size) } });
    } catch { return undefined; }
  },
  async put(key, response) {
    const name = fileName(key);
    try {
      const dir = await modelsDir;
      const part = await dir.getFileHandle(name + '.part', { create: true });
      const w = await part.createWritable();
      await response.body.pipeTo(w);            // נכתב ישר לדיסק בלי להכפיל זיכרון
      await part.move(name);                      // רק קובץ שנכתב עד הסוף נחשב "שמור"
    } catch (e) {
      console.warn('model cache write failed', e);
      try { (await modelsDir).removeEntry(name + '.part'); } catch {}
    }
  },
};
if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.getDirectory) {
  env.useCustomCache = true;
  env.customCache = opfsCache;
}

let asr = null;
let asrKey = '';
let wordTimestampsOK = true;

const LANG = { he: 'hebrew', en: 'english', ar: 'arabic', ru: 'russian', fr: 'french', es: 'spanish' };

function dtypeFor(model, device, f16) {
  if (device === 'webgpu') {
    if (model.includes('large') || model.includes('ivrit')) return { encoder_model: f16 ? 'fp16' : 'q4', decoder_model_merged: 'q4' };
    return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  }
  if (model.includes('large') || model.includes('ivrit')) return { encoder_model: 'q4', decoder_model_merged: 'q4' };
  return 'q8';
}

async function load(model, device, f16) {
  const key = model + '|' + device;
  if (asr && asrKey === key) return asr;
  if (asr) { try { await asr.dispose(); } catch {} asr = null; }
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total > 1e6) {
      self.postMessage({ type: 'load', file: p.file, loaded: p.loaded, total: p.total });
    }
  };
  try {
    asr = await pipeline('automatic-speech-recognition', model, { device, dtype: dtypeFor(model, device, f16), progress_callback });
  } catch (err) {
    if (device !== 'webgpu') throw err;
    // אין WebGPU תקין — נופלים למעבד
    self.postMessage({ type: 'info', message: 'כרטיס המסך לא זמין, מתמלל על המעבד (איטי יותר)' });
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: dtypeFor(model, 'wasm'), progress_callback });
  }
  asrKey = key;
  wordTimestampsOK = true;
  return asr;
}

self.onmessage = async (e) => {
  const { id, audio, model, device, f16, language } = e.data;
  try {
    const p = await load(model, device, f16);
    self.postMessage({ type: 'ready', id });
    const opts = { task: 'transcribe' };
    if (LANG[language]) opts.language = LANG[language];

    let out, kind = 'word';
    if (wordTimestampsOK) {
      try { out = await p(audio, { ...opts, return_timestamps: 'word' }); }
      catch (err) { wordTimestampsOK = false; }
    }
    if (!out) {
      kind = 'segment';
      try { out = await p(audio, { ...opts, return_timestamps: true }); }
      catch (err) { kind = 'text'; out = await p(audio, opts); }
    }
    self.postMessage({ type: 'done', id, kind, text: out.text || '', chunks: out.chunks || [] });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};
