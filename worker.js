// Worker לתמלול מקומי עם Whisper (transformers.js). רץ ברקע כדי שהממשק לא ייתקע.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

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
