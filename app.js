/* קליל כתוביות — תמלול אוטומטי + עריכה + צריבה, הכל בדפדפן */
'use strict';

/* ---------- עזרים ---------- */
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (t, dec = 1) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`; };
const HEB = /[֐-׿؀-ۿ]/;
const store = {
  get(k, d) { try { const v = localStorage.getItem('subs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('subs.' + k, JSON.stringify(v)); } catch {} },
};
let toastTimer;
function toast(msg, ms = 2800) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

/* ---------- מצב ---------- */
const settings = Object.assign({ engine: 'auto', lang: 'he', model: 'auto', style: 'bold', pos: 'bottom', size: 6, karaoke: true, len: 30 }, store.get('settings', {}));
const saveSettings = () => store.set('settings', settings);
const S = {
  file: null, key: '', video: null, dur: 0,
  words: [],      // [{text,start,end}] — מה שהמודל החזיר
  blocks: [],     // [{id,start,end,text,words|null}] — הכתוביות שעורכים
  edited: false, busy: false, playing: false, exporting: null,
};
const MODELS = {
  ivrit: 'taltul1989/kalil-ivrit-whisper-turbo-onnx', // עותק בחשבון שלנו (מקור: ivrit-ai, המרה: instush)
  turbo: 'onnx-community/whisper-large-v3-turbo',
  small: 'Xenova/whisper-small',
};
let hasWebGPU = false, hasF16 = false;
const gpuReady = (async () => {
  try { const ad = navigator.gpu && await navigator.gpu.requestAdapter(); if (ad) { hasWebGPU = true; hasF16 = ad.features.has('shader-f16'); } } catch {}
  const n = $('#device-note');
  if (!hasWebGPU) { n.textContent = '⚠ הדפדפן הזה לא מאפשר שימוש בכרטיס המסך, אז התמלול יהיה איטי ופחות מדויק. מומלץ Chrome או Edge מעודכנים.'; n.classList.add('warn'); }
  else n.textContent = 'בפעם הראשונה יורד מודל התמלול (כ-1.6GB) ונשמר בדפדפן. מהפעם השנייה זה מיידי.';
})();
function modelId() {
  if (settings.model !== 'auto') return MODELS[settings.model];
  if (!hasWebGPU) return MODELS.small;
  return settings.lang === 'he' ? MODELS.ivrit : MODELS.turbo;
}

/* ---------- טעינת סרטון ---------- */
async function loadFile(f) {
  if (!f) return;
  if (!/^(video|audio)\//.test(f.type) && !/\.(mp4|mov|mkv|webm|m4v|avi|mp3|wav|m4a|aac|ogg)$/i.test(f.name)) return toast('צריך לבחור קובץ וידאו');
  if (S.busy) return toast('רגע, עוד מתמלל את הסרטון הקודם');
  wakeServer();
  resetVideo();
  const v = document.createElement('video');
  v.preload = 'auto'; v.playsInline = true; v.src = URL.createObjectURL(f);
  $('#pool').appendChild(v);
  try { await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('format')); }); }
  catch { toast('הדפדפן לא מצליח לפתוח את הקובץ הזה', 4000); v.remove(); return; }
  if (!isFinite(v.duration)) { await new Promise((r) => { v.ondurationchange = () => isFinite(v.duration) && r(); v.currentTime = 1e7; setTimeout(r, 4000); }); v.currentTime = 0; }
  S.file = f; S.video = v; S.dur = v.duration;
  S.key = `${f.name}|${f.size}|${Math.round(S.dur)}`;
  v.addEventListener('seeked', () => { if (!S.playing) draw(); updateTime(); });
  v.addEventListener('loadeddata', () => draw());
  v.addEventListener('ended', onEnded);
  sizeCanvas();
  $('#start').hidden = true; $('#editor').hidden = false; $('#btn-new').hidden = false;
  if (matchMedia('(max-width: 860px)').matches) $('.style-box').open = false;
  $('#seek').max = S.dur; updateTime();
  const saved = store.get('proj:' + S.key, null);
  if (saved && saved.blocks && saved.blocks.length) {
    S.words = saved.words || []; S.blocks = saved.blocks; S.edited = !!saved.edited;
    renderBlocks(); draw(); toast('נטען התמלול ששמרתם לסרטון הזה ✓');
  } else {
    S.words = []; S.blocks = []; S.edited = false; renderBlocks();
    transcribe();
  }
}
function resetVideo() {
  pause();
  if (S.video) { URL.revokeObjectURL(S.video.src); S.video.remove(); }
  S.video = null; S.srcNode = null;
}
function sizeCanvas() {
  const v = S.video, cv = $('#screen');
  let w = v.videoWidth || 1280, h = v.videoHeight || 720;
  const sc = Math.min(1, 1920 / Math.max(w, h)); w = Math.round(w * sc / 2) * 2; h = Math.round(h * sc / 2) * 2;
  cv.width = w; cv.height = h;
}

/* ---------- ניגון ---------- */
let actx = null, speaker = null, recDest = null;
function ensureAudio() {
  if (!S.video) return;
  if (!actx) {
    actx = new AudioContext();
    speaker = actx.createGain(); speaker.connect(actx.destination);
    recDest = actx.createMediaStreamDestination();
  }
  if (!S.srcNode) {
    S.srcNode = actx.createMediaElementSource(S.video);
    S.srcNode.connect(speaker); S.srcNode.connect(recDest);
  }
  if (actx.state === 'suspended') actx.resume();
}
function play() {
  if (!S.video) return;
  ensureAudio();
  if (S.video.currentTime >= S.dur - 0.05) S.video.currentTime = 0;
  S.video.play().catch(() => {});
  S.playing = true; uiPlay(); frameLoop();
}
function pause() { if (S.video) S.video.pause(); S.playing = false; uiPlay(); draw(); }
function togglePlay() { S.playing ? pause() : play(); }
function seek(t) { if (!S.video) return; S.video.currentTime = clamp(t, 0, S.dur); updateTime(); }
function onEnded() { S.playing = false; uiPlay(); if (S.exporting) finishExport(); }
function frameLoop() {
  if (!S.playing && !S.exporting) return;
  draw(); updateTime(true);
  const v = S.video;
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(frameLoop); else requestAnimationFrame(frameLoop);
}
function uiPlay() { const p = S.playing; $('#btn-play').textContent = p ? '⏸' : '▶'; $('#big-play').hidden = p; }
let lastCur = null;
function updateTime(follow) {
  const t = S.video ? S.video.currentTime : 0;
  $('#time').textContent = `${fmt(t, 0)} / ${fmt(S.dur, 0)}`;
  if (document.activeElement !== $('#seek')) $('#seek').value = t;
  const b = blockAt(t);
  if (b !== lastCur) {
    document.querySelectorAll('.blk.cur').forEach((e) => e.classList.remove('cur'));
    if (b) {
      const el = document.querySelector(`.blk[data-id="${b.id}"]`);
      if (el) {
        el.classList.add('cur');
        const editing = document.activeElement && document.activeElement.classList.contains('blk-text');
        if (follow && !editing) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    lastCur = b;
  }
  if (S.exporting) { const p = t / S.dur; $('#export-bar').style.width = p * 100 + '%'; $('#export-txt').textContent = Math.round(p * 100) + '%'; }
}

/* ---------- ציור + כתוביות ---------- */
const cv = $('#screen'), cx = cv.getContext('2d');
const blockAt = (t) => S.blocks.find((b) => t >= b.start && t < b.end) || null;
function draw() {
  const v = S.video; if (!v) return;
  cx.fillStyle = '#000'; cx.fillRect(0, 0, cv.width, cv.height);
  if (v.readyState >= 2 && v.videoWidth) cx.drawImage(v, 0, 0, cv.width, cv.height);
  const b = blockAt(v.currentTime);
  if (b && b.text.trim()) drawCaption(b, v.currentTime);
}
function blockWords(b) {
  // מילים עם זמנים — מהמודל, או מחולקות לפי אורך אם הטקסט נערך
  const parts = b.text.trim().split(/\s+/).filter(Boolean);
  if (b.words && b.words.length === parts.length) return b.words.map((w, i) => ({ ...w, text: parts[i] }));
  const total = parts.reduce((a, p) => a + p.length + 1, 0); let t = b.start;
  return parts.map((p) => { const d = (b.end - b.start) * (p.length + 1) / total; const w = { text: p, start: t, end: t + d }; t += d; return w; });
}
function drawCaption(b, t) {
  const W = cv.width, H = cv.height;
  const fs = Math.round(Math.min(W, H) * settings.size / 100 * 1.5);
  cx.font = `800 ${fs}px Rubik, "Segoe UI", Arial, sans-serif`;
  cx.textBaseline = 'middle';
  const rtl = HEB.test(b.text);
  const words = blockWords(b);
  const space = cx.measureText(' ').width, maxW = W * 0.86;
  // שבירת שורות
  const lines = []; let line = [], lw = 0;
  for (const w of words) {
    const ww = cx.measureText(w.text).width;
    if (line.length && lw + space + ww > maxW) { lines.push({ words: line, w: lw }); line = []; lw = 0; }
    line.push({ ...w, w: ww }); lw += (line.length > 1 ? space : 0) + ww;
  }
  if (line.length) lines.push({ words: line, w: lw });
  const lh = fs * 1.28, blockH = lines.length * lh;
  const y0 = settings.pos === 'top' ? H * 0.09 : settings.pos === 'middle' ? (H - blockH) / 2 : H * 0.88 - blockH;
  const st = settings.style;
  const base = st === 'yellow' ? '#FFD60A' : '#FFFFFF';
  const hl = st === 'yellow' ? '#FFFFFF' : '#FFD60A';
  lines.forEach((ln, i) => {
    const y = y0 + i * lh + lh / 2;
    if (st === 'box') {
      const pad = fs * 0.35;
      cx.fillStyle = 'rgba(0,0,0,.66)';
      cx.beginPath(); (cx.roundRect || cx.rect).call(cx, (W - ln.w) / 2 - pad, y - lh / 2 + fs * 0.04, ln.w + pad * 2, lh - fs * 0.08, fs * 0.22); cx.fill();
    }
    // מציירים מילה-מילה: בעברית מימין לשמאל
    let x = rtl ? (W + ln.w) / 2 : (W - ln.w) / 2;
    for (const w of ln.words) {
      const active = settings.karaoke && t >= w.start && t < w.end;
      const wx = rtl ? x - w.w : x;
      cx.textAlign = 'left'; cx.direction = 'ltr';
      if (rtl) { cx.direction = 'rtl'; cx.textAlign = 'right'; }
      const drawX = rtl ? x : x;
      if (st !== 'box') {
        cx.lineJoin = 'round'; cx.lineWidth = Math.max(3, fs * 0.2); cx.strokeStyle = '#000';
        cx.strokeText(w.text, drawX, y);
      }
      cx.fillStyle = active ? hl : base;
      cx.fillText(w.text, drawX, y);
      x = rtl ? wx - space : x + w.w + space;
    }
  });
}

/* ---------- כתוביות: בניה מהמילים ---------- */
function groupWords(words, maxChars) {
  const blocks = []; let cur = null;
  for (const w of words) {
    const last = cur && cur.words[cur.words.length - 1];
    const len = cur ? cur.words.reduce((a, x) => a + x.text.length + 1, 0) : 0;
    // מילה אחרונה במשפט לא נשארת לבד בשורה — מותר לחרוג קצת
    const tooLong = len + w.text.length > maxChars && !(/[.!?؟]$/.test(w.text) && len + w.text.length <= maxChars * 1.35 && w.start - (cur ? cur.end : 0) < 0.5);
    if (!cur || tooLong || w.start - cur.end > 0.7 || /[.!?؟]$/.test(last.text) || (maxChars > 20 && /[,،]$/.test(last.text) && len > maxChars * 0.6)) {
      cur = { id: uid(), start: w.start, end: w.end, words: [w] }; blocks.push(cur);
    } else { cur.words.push(w); cur.end = w.end; }
  }
  blocks.forEach((b, i) => {
    b.text = b.words.map((w) => w.text).join(' ');
    const next = blocks[i + 1];
    b.end = Math.max(b.end, b.start + 0.6);
    if (next && next.start - b.end < 0.5) b.end = next.start;
    if (next && b.end > next.start) b.end = next.start;
  });
  return blocks;
}
function regroup() { S.blocks = groupWords(S.words, +settings.len); renderBlocks(); draw(); save(); }

/* ---------- רשימת הכתוביות ---------- */
function renderBlocks() {
  const box = $('#blocks');
  if (!S.blocks.length) {
    box.innerHTML = S.busy ? '<div class="empty">הכתוביות יופיעו כאן תוך כדי התמלול…</div>' : '<div class="empty">לא זוהה דיבור בסרטון.</div>';
    return;
  }
  const q = $('#search').value.trim().toLowerCase();
  box.innerHTML = '';
  for (const b of S.blocks) {
    const el = document.createElement('div');
    el.className = 'blk' + (q && b.text.toLowerCase().includes(q) ? ' hit' : '');
    el.dataset.id = b.id;
    el.innerHTML = `<div class="blk-top">
        <button class="tbtn" data-a="start" title="קביעת ההתחלה לנקודה הנוכחית בסרטון">${fmt(b.start)}</button> –
        <button class="tbtn" data-a="end" title="קביעת הסוף לנקודה הנוכחית בסרטון">${fmt(b.end)}</button></div>
      <div class="blk-text" dir="auto" contenteditable="${S.busy ? 'false' : 'true'}" spellcheck="false"></div>
      <div class="blk-acts">
        <button data-a="play">▶ נגן</button>
        <button data-a="split" title="חיתוך השורה במקום של הסמן">✂ פצל כאן</button>
        <button data-a="merge" title="איחוד עם השורה הבאה">⤓ אחד עם הבאה</button>
        <button data-a="add" title="הוספת שורה חדשה אחרי השורה הזו">➕ אחרי</button>
        <button data-a="del" class="del">🗑</button>
      </div>`;
    el.querySelector('.blk-text').textContent = b.text;
    box.appendChild(el);
  }
  lastCur = null; updateTime();
}
const blocksBox = $('#blocks');
blocksBox.addEventListener('click', (e) => {
  const el = e.target.closest('.blk'); if (!el) return;
  const i = S.blocks.findIndex((b) => b.id === el.dataset.id), b = S.blocks[i];
  const a = e.target.closest('[data-a]') && e.target.closest('[data-a]').dataset.a;
  if (!a) { if (!e.target.closest('.blk-text')) { pause(); seek(b.start + 0.01); } return; }
  if (S.busy) return toast('אפשר לערוך אחרי שהתמלול יסתיים');
  const t = S.video.currentTime;
  if (a === 'play') { seek(b.start + 0.01); play(); stopAt = b.end; }
  else if (a === 'start') {
    const prev = S.blocks[i - 1];
    if (t >= b.end - 0.1) return toast('הסמן צריך להיות לפני סוף השורה');
    b.start = Math.max(t, prev ? prev.start + 0.1 : 0); if (prev && prev.end > b.start) prev.end = b.start;
    changed(true); toast('ההתחלה עודכנה ל-' + fmt(b.start));
  } else if (a === 'end') {
    const next = S.blocks[i + 1];
    if (t <= b.start + 0.1) return toast('הסמן צריך להיות אחרי תחילת השורה');
    b.end = Math.min(t, next ? next.end - 0.1 : S.dur); if (next && next.start < b.end) next.start = b.end;
    changed(true); toast('הסוף עודכן ל-' + fmt(b.end));
  } else if (a === 'merge') {
    const next = S.blocks[i + 1]; if (!next) return;
    b.text = (b.text + ' ' + next.text).trim(); b.end = next.end;
    b.words = b.words && next.words ? b.words.concat(next.words) : null;
    S.blocks.splice(i + 1, 1); changed(true);
  } else if (a === 'add') {
    const next = S.blocks[i + 1];
    const gapAfter = (next ? next.start : S.dur) - b.end;
    addBlockAt(gapAfter > 0.4 ? b.end : (b.start + b.end) / 2);
  } else if (a === 'del') {
    S.blocks.splice(i, 1); changed(true); toast('השורה נמחקה');
  } else if (a === 'split') {
    const txt = el.querySelector('.blk-text');
    let off = caretOffset(txt);
    if (off == null || off <= 0 || off >= b.text.length) off = Math.round(b.text.length / 2);
    // מזיזים לגבול מילה
    const sp = b.text.lastIndexOf(' ', off) > 0 ? b.text.lastIndexOf(' ', off) : b.text.indexOf(' ', off);
    if (sp <= 0) return toast('אין מה לפצל — רק מילה אחת');
    const left = b.text.slice(0, sp).trim(), right = b.text.slice(sp).trim();
    const nLeft = left.split(/\s+/).length;
    const ws = blockWords(b);
    const mid = ws[nLeft] ? ws[nLeft].start : b.start + (b.end - b.start) * left.length / b.text.length;
    const nb = { id: uid(), start: mid, end: b.end, text: right, words: b.words ? b.words.slice(nLeft) : null };
    b.text = left; b.end = mid; b.words = b.words ? b.words.slice(0, nLeft) : null;
    S.blocks.splice(i + 1, 0, nb); changed(true);
  }
});
// הוספת שורה חדשה בנקודת זמן (למשל משפט שהתמלול פספס)
function addBlockAt(t) {
  if (!S.video) return;
  if (S.busy) return toast('אפשר להוסיף שורות אחרי שהתמלול יסתיים');
  pause();
  t = clamp(t, 0, S.dur);
  let idx = S.blocks.findIndex((b) => t >= b.start && t < b.end);
  let nb;
  if (idx >= 0) {
    // הסמן בתוך שורה קיימת — מחלקים את הזמן שלה: השורה הקיימת עד הסמן, החדשה מהסמן
    const b = S.blocks[idx];
    if (t - b.start < 0.3) t = b.start + (b.end - b.start) / 2;
    nb = { id: uid(), start: t, end: b.end, text: '', words: null };
    b.end = t; idx += 1;
  } else {
    // הסמן ברווח בין שורות — שורה של עד 2.5 שניות, עד השורה הבאה
    idx = S.blocks.findIndex((b) => b.start > t); if (idx < 0) idx = S.blocks.length;
    const next = S.blocks[idx];
    nb = { id: uid(), start: t, end: Math.min(t + 2.5, next ? next.start : S.dur), text: '', words: null };
  }
  if (nb.end - nb.start < 0.3) return toast('אין כאן מקום לשורה — הזיזו קצת את הסרטון');
  S.blocks.splice(idx, 0, nb);
  changed(true);
  seek(nb.start + 0.01);
  const el = document.querySelector(`.blk[data-id="${nb.id}"] .blk-text`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
}
$('#btn-add').onclick = () => addBlockAt(S.video ? S.video.currentTime : 0);
function caretOffset(el) {
  const sel = getSelection(); if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
blocksBox.addEventListener('focusin', (e) => {
  const el = e.target.closest('.blk-text'); if (!el) return;
  const b = S.blocks.find((x) => x.id === el.closest('.blk').dataset.id);
  if (b) { pause(); const t = S.video.currentTime; if (t < b.start || t >= b.end) seek(b.start + 0.01); }
});
blocksBox.addEventListener('input', (e) => {
  const el = e.target.closest('.blk-text'); if (!el) return;
  const b = S.blocks.find((x) => x.id === el.closest('.blk').dataset.id); if (!b) return;
  b.text = el.textContent.replace(/\s+/g, ' ');
  if (b.words && b.text.trim().split(/\s+/).length !== b.words.length) b.words = null;
  S.edited = true; draw(); saveSoon();
});
blocksBox.addEventListener('keydown', (e) => {
  if (e.target.closest('.blk-text') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});
let stopAt = null;
setInterval(() => { if (stopAt != null && S.playing && S.video.currentTime >= stopAt) { pause(); stopAt = null; } else if (!S.playing) stopAt = null; }, 50);
function changed(rerender) { S.edited = true; if (rerender) renderBlocks(); draw(); save(); }
let saveT;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(save, 600); }
function save() { if (S.key) store.set('proj:' + S.key, { words: S.words, blocks: S.blocks, edited: S.edited, at: Date.now() }); }
$('#search').addEventListener('input', renderBlocks);

/* ---------- תמלול ---------- */
let worker = null, seq = 0;
function workerRun(audio, onEvent) {
  if (!worker) worker = new Worker('worker.js', { type: 'module' });
  const id = ++seq;
  return new Promise((res, rej) => {
    worker.onmessage = (e) => {
      const d = e.data; if (d.id && d.id !== id) return;
      if (d.type === 'done') res(d); else if (d.type === 'error') rej(new Error(d.message)); else onEvent(d);
    };
    worker.onerror = (e) => rej(new Error(e.message || 'worker'));
    worker.postMessage({ id, audio, model: modelId(), device: hasWebGPU ? 'webgpu' : 'wasm', f16: hasF16, language: settings.lang });
  });
}
async function decodePcm(file) {
  const buf = await file.arrayBuffer();
  const ab = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(buf);
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) { const d = ab.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / ab.numberOfChannels; }
  return out;
}
function chunkPoints(pcm, minS, maxS) {
  const sr = 16000, n = pcm.length, out = [], win = 800; let s = 0;
  while (s < n) {
    if (n - s <= maxS * sr) { out.push([s, n]); break; }
    let best = s + maxS * sr, bestE = Infinity;
    for (let p = s + minS * sr; p < s + maxS * sr - win; p += win) {
      let e = 0; for (let k = p; k < p + win; k += 2) e += pcm[k] * pcm[k];
      if (e < bestE) { bestE = e; best = p + win / 2; }
    }
    out.push([s, best]); s = best;
  }
  return out;
}
const rms = (a) => { let e = 0; for (let i = 0; i < a.length; i += 4) e += a[i] * a[i]; return Math.sqrt(e / (a.length / 4)); };
function spread(text, s, e) {
  const parts = text.trim().split(/\s+/).filter(Boolean); if (!parts.length) return [];
  const total = parts.reduce((a, p) => a + p.length + 1, 0); let t = s;
  return parts.map((p) => { const d = (e - s) * (p.length + 1) / total; const w = { text: p, start: t, end: t + d }; t += d; return w; });
}
const BIDI = /[‎‏‪-‮⁦-⁩﻿]/g; // תווי כיוון נסתרים שהמודל מוסיף
function cleanWords(ws) {
  const out = [];
  for (const w of ws) {
    w.text = w.text.replace(BIDI, '').trim();
    if (!w.text) continue;
    const prev = out[out.length - 1];
    // "-5" או סימן פיסוק בודד — מצמידים למילה הקודמת ("ה-5")
    if (prev && (/^[-–־]/.test(w.text) || /^[^\p{L}\p{N}]+$/u.test(w.text))) { prev.text += w.text; prev.end = w.end; continue; }
    out.push(w);
  }
  return out;
}
function resToWords(d, off, len) { return cleanWords(resToWordsRaw(d, off, len)); }
function resToWordsRaw(d, off, len) {
  const out = [];
  if (d.kind === 'word') {
    for (const c of d.chunks) {
      const text = (c.text || '').trim(); if (!text) continue;
      const s = c.timestamp[0] ?? 0, e = c.timestamp[1] ?? Math.min(len, s + 0.4);
      out.push({ text, start: off + s, end: off + Math.max(e, s + 0.05) });
    }
  } else if (d.kind === 'segment' && d.chunks.length) {
    for (const c of d.chunks) out.push(...spread(c.text || '', off + (c.timestamp[0] ?? 0), off + (c.timestamp[1] ?? len)));
  } else out.push(...spread(d.text, off, off + len));
  return out;
}
function txStatus(text, p) {
  $('#tx-status').hidden = text == null;
  if (text != null) { $('#tx-st-text').textContent = text; if (p != null) $('#tx-st-bar').style.width = clamp(p, 0, 1) * 100 + '%'; }
}
async function transcribe() {
  if (S.busy || !S.file) return;
  await gpuReady;
  S.busy = true; S.words = []; S.blocks = []; S.edited = false; renderBlocks();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {} // שהדפדפן לא ימחק את המודל
  const key = S.key;
  let lock = null; try { lock = await navigator.wakeLock.request('screen'); } catch {}
  txStatus('מכין את האודיו…', 0);
  try {
    const pcm = await decodePcm(S.file);
    if (useServer()) { if (!(await transcribeOnServer(pcm, key))) { S.busy = false; txStatus(null); return; } }
    else {
    const parts = chunkPoints(pcm, 20, 28);
    let ready = false; const t0 = performance.now(); let doneSec = 0;
    for (let i = 0; i < parts.length; i++) {
      if (S.key !== key) return; // החליפו סרטון באמצע
      const [a, b] = parts[i]; const seg = pcm.slice(a, b);
      if (rms(seg) < 0.003) continue;
      const pct = i / parts.length;
      if (ready) txStatus(`מתמלל… ${Math.round(pct * 100)}%${eta(t0, doneSec, pcm.length / 16000)}`, pct);
      const d = await workerRun(seg, (ev) => {
        if (ev.type === 'load') txStatus(`טוען את מודל התמלול… ${Math.round(ev.loaded / ev.total * 100)}%  (בפעם הראשונה הוא יורד, כ-1.6GB)`, ev.loaded / ev.total);
        else if (ev.type === 'ready' && !ready) { ready = true; txStatus(`מתמלל… ${Math.round(pct * 100)}%`, pct); }
        else if (ev.type === 'info') toast(ev.message, 4000);
      });
      doneSec = b / 16000;
      S.words.push(...resToWords(d, a / 16000, (b - a) / 16000));
      S.blocks = groupWords(S.words, +settings.len); renderBlocks(); draw();
    }
    }
    for (let i = 1; i < S.words.length; i++) if (S.words[i].start < S.words[i - 1].start) S.words[i].start = S.words[i - 1].start;
    S.blocks = groupWords(S.words, +settings.len);
    S.busy = false; txStatus(null); renderBlocks(); draw(); save();
    toast(S.blocks.length ? `התמלול הסתיים ✓ ${S.blocks.length} שורות` : 'לא זוהה דיבור בסרטון', 3500);
  } catch (err) {
    console.error(err); S.busy = false; txStatus(null); renderBlocks();
    toast(/decode|EncodingError/i.test(err.message) ? 'לא הצלחתי לקרוא את הסאונד של הסרטון' : 'התמלול נכשל: ' + err.message, 6000);
  } finally { try { lock && lock.release(); } catch {} }
}
/* ---------- תמלול בשרת (Modal) — רק למי שיש לו מפתח ---------- */
const SERVER = 'https://taltul1989--kalil-transcribe-transcriber-web.us-east.modal.run';
const serverKey = () => store.get('serverKey', '');
function useServer() {
  if (!serverKey() || settings.engine === 'device') return false;
  return true; // יש מפתח: השרת מהיר יותר מכל מכשיר (כמה שניות לדקת סרטון)
}
// מעירים את השרת ברגע שבוחרים סרטון — כך ההתעוררות קורית בזמן שהטלפון מחלץ את הסאונד
function wakeServer() { if (useServer()) fetch(SERVER + '/health').catch(() => {}); }
function encodeWav(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, clamp(pcm[i], -1, 1) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}
async function transcribeOnServer(pcm, key) {
  const parts = chunkPoints(pcm, 100, 120); // חתיכות של כשתי דקות — רואים התקדמות, והשרת נשאר ער ביניהן
  const total = pcm.length / 16000;
  for (let i = 0; i < parts.length; i++) {
    if (S.key !== key) return false;
    const [a, b] = parts[i];
    const pct = i / parts.length, span = 1 / parts.length;
    const t0 = performance.now();
    // פס התקדמות שזז בהדרגה בזמן שמחכים לשרת (גם אם הוא מתעורר) — בלי הודעות טכניות
    let shown = pct;
    txStatus(`מתמלל… ${Math.round(shown * 100)}%`, shown);
    const slow = setInterval(() => {
      shown += (pct + span * 0.95 - shown) * 0.02;
      if (S.busy) txStatus(`מתמלל… ${Math.round(shown * 100)}%`, shown);
    }, 250);
    let res;
    const body = encodeWav(pcm.subarray(a, b));
    for (let attempt = 1; ; attempt++) {
      // אם התשובה לא הגיעה תוך 100 שניות (רשת חלשה / חיבור שנפל) — שולחים שוב
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 100000);
      try {
        res = await fetch(`${SERVER}/transcribe?language=${encodeURIComponent(settings.lang)}`, {
          method: 'POST', headers: { 'x-kalil-key': serverKey() }, body, signal: ctrl.signal,
        });
        res = { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null }; // גם קריאת התשובה בתוך מגבלת הזמן
        clearTimeout(timer);
        if (res.status >= 500 && attempt < 3) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
        break;
      } catch (e) {
        clearTimeout(timer);
        if (S.key !== key) { clearInterval(slow); return false; }
        if (attempt >= 3) { clearInterval(slow); throw new Error('אין חיבור לשרת. בדקו את האינטרנט ונסו שוב'); }
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    clearInterval(slow);
    if (res.status === 401) { store.set('serverKey', ''); throw new Error('הקישור לשרת לא תקין. פתחו שוב את קישור החיבור'); }
    if (!res.ok) throw new Error('השרת החזיר שגיאה ' + res.status);
    const d = res.data;
    txStatus(`מתמלל… ${Math.round((pct + span) * 100)}%`, pct + span);
    const off = a / 16000;
    S.words.push(...cleanWords(d.words.map((w) => ({ text: w.text, start: off + w.start, end: off + w.end }))));
    S.blocks = groupWords(S.words, +settings.len); renderBlocks(); draw();
    console.log(`server chunk ${i + 1}/${parts.length}: ${((b - a) / 16000).toFixed(0)}s audio in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  return true;
}
// חיבור המכשיר לשרת: פותחים פעם אחת קישור עם #key=... — המפתח נשמר רק במכשיר הזה
(function readKeyFromLink() {
  const m = location.hash.match(/key=([A-Za-z0-9_-]{10,})/);
  if (!m) return;
  store.set('serverKey', m[1]);
  history.replaceState(null, '', location.pathname + location.search); // מוחקים את המפתח משורת הכתובת
  setTimeout(() => toast('המכשיר מחובר לשרת התמלול ✓ מעכשיו התמלול מהיר', 5000), 300);
})();

function eta(t0, doneSec, totalSec) {
  if (doneSec < 20) return '';
  const el = (performance.now() - t0) / 1000, rate = el / doneSec, left = (totalSec - doneSec) * rate;
  return left > 5 ? ` · עוד כ-${left > 90 ? Math.round(left / 60) + ' דק׳' : Math.round(left) + ' שנ׳'}` : '';
}

/* ---------- ייצוא ---------- */
async function exportVideo() {
  if (!S.video || S.busy) return toast(S.busy ? 'מחכים שהתמלול יסתיים' : 'אין סרטון');
  pause(); ensureAudio();
  await document.fonts.load('800 40px Rubik').catch(() => {});
  const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  const stream = cv.captureStream(30);
  recDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10e6, audioBitsPerSecond: 192e3 });
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  S.exporting = { rec, chunks, mime, cancelled: false };
  try { S.exporting.lock = await navigator.wakeLock.request('screen'); } catch {}
  speaker.gain.value = 0;
  $('#export-overlay').hidden = false;
  S.video.currentTime = 0;
  await new Promise((r) => S.video.addEventListener('seeked', r, { once: true }));
  draw(); rec.start(500);
  S.video.play(); frameLoop();
}
function finishExport() {
  const ex = S.exporting; if (!ex) return;
  S.exporting = null; speaker.gain.value = 1;
  try { ex.lock && ex.lock.release(); } catch {}
  ex.rec.onstop = () => {
    if (ex.cancelled) { $('#export-overlay').hidden = true; return toast('בוטל'); }
    const ext = ex.mime.includes('mp4') ? 'mp4' : 'webm';
    const base = S.file.name.replace(/\.[^.]+$/, '');
    const name = `${base}-כתוביות.${ext}`;
    const blob = new Blob(ex.chunks, { type: ex.mime.split(';')[0] });
    const file = new File([blob], name, { type: blob.type });
    const canShare = matchMedia('(pointer: coarse)').matches && !!(navigator.canShare && navigator.canShare({ files: [file] }));
    if (!canShare) { // מחשב: הורדה רגילה
      $('#export-overlay').hidden = true;
      download(blob, name); toast('הסרטון מוכן ✓ נשמר בהורדות', 4000); return;
    }
    // טלפון: חלון "מוכן" — השיתוף חייב לצאת מלחיצה של המשתמש
    $('#export-progress').hidden = true; $('#export-done').hidden = false;
    $('#btn-share').onclick = async () => {
      try { await navigator.share({ files: [file], title: name }); closeDone(); }
      catch (e) { if (e.name !== 'AbortError') toast('השיתוף לא הצליח — אפשר להוריד כקובץ'); }
    };
    $('#btn-download').onclick = () => { download(blob, name); toast('נשמר בהורדות ✓ (מופיע גם בגלריה, באלבום "Download")', 4500); closeDone(); };
  };
  ex.rec.stop();
}
function closeDone() { $('#export-overlay').hidden = true; $('#export-done').hidden = true; $('#export-progress').hidden = false; }
$('#btn-done-close').onclick = closeDone;
$('#btn-export').onclick = exportVideo;
$('#btn-export-cancel').onclick = () => { if (S.exporting) { S.exporting.cancelled = true; S.video.pause(); finishExport(); } };

const ts = (t, sep) => { const ms = Math.round(t * 1000); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`; };
const baseName = () => (S.file ? S.file.name.replace(/\.[^.]+$/, '') : 'subs');
const live = () => S.blocks.filter((b) => b.text.trim());
$('#btn-srt').onclick = () => { if (!live().length) return toast('אין עדיין כתוביות'); download(new Blob(['﻿' + live().map((b, i) => `${i + 1}\n${ts(b.start, ',')} --> ${ts(b.end, ',')}\n${b.text.trim()}\n`).join('\n')], { type: 'text/plain' }), baseName() + '.srt'); };
$('#btn-vtt').onclick = () => { if (!live().length) return toast('אין עדיין כתוביות'); download(new Blob(['WEBVTT\n\n' + live().map((b) => `${ts(b.start, '.')} --> ${ts(b.end, '.')}\n${b.text.trim()}\n`).join('\n')], { type: 'text/vtt' }), baseName() + '.vtt'); };
$('#btn-txt').onclick = () => { if (!live().length) return toast('אין עדיין טקסט'); download(new Blob(['﻿' + live().map((b) => b.text.trim()).join('\n')], { type: 'text/plain' }), baseName() + '.txt'); };
$('#btn-copy').onclick = async () => { const t = live().map((b) => b.text.trim()).join('\n'); if (!t) return toast('אין עדיין טקסט'); try { await navigator.clipboard.writeText(t); toast('הטקסט הועתק ✓'); } catch { toast('ההעתקה לא הצליחה'); } };

/* ---------- עיצוב ---------- */
function bindSeg(id, key) {
  const seg = $(id);
  const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(settings[key])));
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; settings[key] = b.dataset.v; saveSettings(); sync(); draw(); });
  sync();
}
bindSeg('#style-seg', 'style'); bindSeg('#pos-seg', 'pos');
$('#size').value = settings.size; $('#size').oninput = (e) => { settings.size = +e.target.value; saveSettings(); draw(); };
$('#karaoke').checked = settings.karaoke; $('#karaoke').onchange = (e) => { settings.karaoke = e.target.checked; saveSettings(); draw(); };
$('#len').value = settings.len;
$('#len').onchange = (e) => {
  if (S.edited && !confirm('שינוי אורך השורה יבנה את הכתוביות מחדש מהתמלול, והתיקונים שעשיתם יימחקו. להמשיך?')) { e.target.value = settings.len; return; }
  settings.len = +e.target.value; saveSettings(); if (S.words.length && !S.busy) { S.edited = false; regroup(); }
};

/* ---------- הגדרות ---------- */
$('#btn-settings').onclick = () => {
  $('#set-lang').value = settings.lang; $('#set-model').value = settings.model;
  $('#set-engine').value = settings.engine;
  $('#server-row').hidden = !serverKey();
  $('#btn-retx').hidden = !S.file || S.busy;
  $('#dlg-settings').showModal();
};
$('#btn-disconnect').onclick = () => { store.set('serverKey', ''); $('#server-row').hidden = true; toast('המכשיר נותק מהשרת'); };
$('#dlg-settings').addEventListener('close', () => {
  const v = $('#dlg-settings').returnValue;
  settings.lang = $('#set-lang').value; settings.model = $('#set-model').value; settings.engine = $('#set-engine').value; saveSettings();
  if (v === 'retx' && S.file) {
    if (S.edited && !confirm('תמלול מחדש ימחק את התיקונים שעשיתם. להמשיך?')) return;
    transcribe();
  }
});

/* ---------- אירועים ---------- */
$('#file').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
$('#btn-new').onclick = () => {
  if (S.busy && !confirm('התמלול עוד רץ. לעצור ולבחור סרטון אחר?')) return;
  if (S.busy) { worker && worker.terminate(); worker = null; S.busy = false; txStatus(null); }
  resetVideo(); S.key = ''; $('#editor').hidden = true; $('#start').hidden = false; $('#btn-new').hidden = true;
};
$('#btn-play').onclick = togglePlay;
$('#big-play').onclick = togglePlay;
cv.addEventListener('click', togglePlay);
$('#seek').addEventListener('input', (e) => { seek(+e.target.value); });
const drop = $('#drop');
let depth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; $('#drop-overlay').hidden = false; } });
window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); depth = 0; $('#drop-overlay').hidden = true; loadFile(e.dataTransfer.files[0]); });
window.addEventListener('keydown', (e) => {
  const a = document.activeElement;
  if (a && (a.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(a.tagName)) || document.querySelector('dialog[open]') || !S.video) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') seek(S.video.currentTime + (e.shiftKey ? 1 / 30 : 2));
  else if (e.key === 'ArrowLeft') seek(S.video.currentTime - (e.shiftKey ? 1 / 30 : 2));
});
window.addEventListener('beforeunload', (e) => { if (S.busy || S.exporting) { e.preventDefault(); e.returnValue = ''; } });

window.__subs = { S, loadFile, settings };
