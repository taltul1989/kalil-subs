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
  v.addEventListener('seeked', () => {
    if (pendingSeek != null) { const t = pendingSeek; pendingSeek = null; v.currentTime = t; } // הגרירה התקדמה בינתיים
    if (!S.playing) draw(); updateTime();
  });
  v.addEventListener('loadeddata', () => draw());
  v.addEventListener('ended', onEnded);
  sizeCanvas();
  $('#start').hidden = true; $('#editor').hidden = false; $('#btn-new').hidden = false;
  // מפענחים את הסאונד פעם אחת: גם לגל הקול בפס הזמן וגם לתמלול
  peaks = null;
  S.pcmP = decodePcm(f).catch(() => null);
  S.pcmP.then((p) => { if (p && S.file === f) { computePeaks(p); drawWave(); } });
  setMTab('subs'); mobileHintOnce(); // בטלפון מתחילים בלשונית הכתוביות
  $('#seek').max = S.dur; updateTime();
  const saved = findSaved(S.key);
  if (saved && saved.blocks && saved.blocks.length && !(saved.partial && !saved.edited)) {
    S.words = saved.words || []; S.blocks = saved.blocks; S.edited = !!saved.edited;
    renderBlocks(); draw(); save(); toast('העבודה ששמרת לסרטון הזה נטענה ✓');
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
function pause() {
  if (S.exporting) return; // בזמן הורדה שום דבר לא עוצר את הסרטון
  if (S.video) S.video.pause(); S.playing = false; uiPlay(); draw();
}
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
  $('#time').textContent = $('#vtime').textContent = `${fmt(t, 0)} / ${fmt(S.dur, 0)}`;
  if (document.activeElement !== $('#seek')) $('#seek').value = t;
  const b = blockAt(t);
  syncStrip();
  if (b !== lastCur) {
    document.querySelectorAll('.blk.cur, .sb.cur').forEach((e) => e.classList.remove('cur'));
    if (b) { const sb = document.querySelector(`.sb[data-id="${b.id}"]`); if (sb) sb.classList.add('cur'); }
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

/* ---------- דוברים: כל דובר = טיימליין משלו עם עיצוב משלו ---------- */
const TRACK_COLORS = ['#FFFFFF', '#5CE1E6', '#FF8FD8', '#7CFF8A', '#FFD60A', '#FFA24D'];
const tr = (b) => b.track || 0;
function ensureTracks() {
  if (!Array.isArray(settings.tracks) || !settings.tracks.length) {
    // מעבר מהגרסה הקודמת: העיצוב הכללי הופך לעיצוב של דובר 1
    const old = settings.style === 'yellow' ? { style: 'bold', color: '#FFD60A' } : { style: settings.style === 'box' ? 'box' : 'bold', color: '#FFFFFF' };
    settings.tracks = [{ name: 'דובר 1', ...old, pos: settings.pos || 'bottom', size: settings.size || 6, karaoke: settings.karaoke !== false }];
    saveSettings();
  }
}
ensureTracks();
S.activeTrack = 0;
const tracks = () => settings.tracks;
const curTrack = () => settings.tracks[S.activeTrack] || settings.tracks[0];
function newTrack() {
  const i = settings.tracks.length;
  settings.tracks.push({ name: `דובר ${i + 1}`, style: 'bold', color: TRACK_COLORS[i % TRACK_COLORS.length], pos: i % 2 ? 'top' : 'bottom', size: settings.tracks[0].size, karaoke: true });
  saveSettings();
  return i;
}
// פרויקט ששמר שורות לדובר 3 — מוודאים שיש מספיק דוברים
function ensureTrackCount() { const max = S.blocks.reduce((m, b) => Math.max(m, tr(b)), 0); while (settings.tracks.length <= max) newTrack(); if (S.activeTrack >= settings.tracks.length) S.activeTrack = 0; }
function neighbors(b) { const list = S.blocks.filter((x) => tr(x) === tr(b)); const i = list.indexOf(b); return { prev: list[i - 1], next: list[i + 1] }; }
const sortBlocks = () => S.blocks.sort((a, b) => a.start - b.start || tr(a) - tr(b));

function draw() {
  const v = S.video; if (!v) return;
  cx.fillStyle = '#000'; cx.fillRect(0, 0, cv.width, cv.height);
  if (v.readyState >= 2 && v.videoWidth) cx.drawImage(v, 0, 0, cv.width, cv.height);
  const t = v.currentTime;
  // כתובית לכל דובר שמדבר עכשיו; דוברים באותו מיקום נערמים אחד מעל השני
  const used = { top: 0, middle: 0, bottom: 0 };
  const layouts = [];
  settings.tracks.forEach((st, r) => {
    const b = S.blocks.find((x) => tr(x) === r && t >= x.start && t < x.end && x.text.trim());
    if (b) layouts.push({ b, st, L: layoutCaption(b, st) });
  });
  const midTotal = layouts.filter((x) => x.st.pos === 'middle').reduce((a, x) => a + x.L.blockH, 0);
  for (const x of layouts) {
    const H = cv.height, gap = x.L.fs * 0.3, p = x.st.pos;
    let y0;
    if (p === 'top') { y0 = H * 0.09 + used.top; used.top += x.L.blockH + gap; }
    else if (p === 'middle') { y0 = (H - midTotal) / 2 + used.middle; used.middle += x.L.blockH + gap; }
    else { y0 = H * 0.88 - x.L.blockH - used.bottom; used.bottom += x.L.blockH + gap; }
    paintCaption(x.L, y0, x.st, t);
  }
}
function blockWords(b) {
  // מילים עם זמנים — מהמודל, או מחולקות לפי אורך אם הטקסט נערך
  const parts = b.text.trim().split(/\s+/).filter(Boolean);
  if (b.words && b.words.length === parts.length) return b.words.map((w, i) => ({ ...w, text: parts[i] }));
  const total = parts.reduce((a, p) => a + p.length + 1, 0); let t = b.start;
  return parts.map((p) => { const d = (b.end - b.start) * (p.length + 1) / total; const w = { text: p, start: t, end: t + d }; t += d; return w; });
}
// מחשבים איך הכתובית נשברת לשורות (לפי העיצוב של הדובר)
function layoutCaption(b, st) {
  const W = cv.width, H = cv.height;
  const fs = Math.round(Math.min(W, H) * st.size / 100 * 1.5);
  cx.font = `800 ${fs}px Rubik, "Segoe UI", Arial, sans-serif`;
  const words = blockWords(b);
  const space = cx.measureText(' ').width, maxW = W * 0.86;
  const lines = []; let line = [], lw = 0;
  for (const w of words) {
    const ww = cx.measureText(w.text).width;
    if (line.length && lw + space + ww > maxW) { lines.push({ words: line, w: lw }); line = []; lw = 0; }
    line.push({ ...w, w: ww }); lw += (line.length > 1 ? space : 0) + ww;
  }
  if (line.length) lines.push({ words: line, w: lw });
  const lh = fs * 1.28;
  return { lines, lh, blockH: lines.length * lh, fs, space, rtl: HEB.test(b.text) };
}
function paintCaption(L, y0, stl, t) {
  const W = cv.width, { lines, lh, fs, space, rtl } = L;
  cx.font = `800 ${fs}px Rubik, "Segoe UI", Arial, sans-serif`;
  cx.textBaseline = 'middle';
  const st = stl.style;
  const base = stl.color || '#FFFFFF';
  const hl = base.toUpperCase() === '#FFD60A' ? '#FFFFFF' : '#FFD60A';
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
      const active = stl.karaoke && t >= w.start && t < w.end;
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
function regroup() { S.blocks = groupWords(S.words, +settings.len); renderBlocks(); draw(); save(); save(); }

/* ---------- רשימת הכתוביות ---------- */
function renderBlocks() {
  const box = $('#blocks');
  const nBefore = settings.tracks.length; ensureTrackCount();
  if (settings.tracks.length !== nBefore) { renderTracksBar(); syncStyleUI(); }
  if (!S.blocks.length) {
    box.innerHTML = S.busy ? '<div class="empty">הכתוביות יופיעו כאן תוך כדי התמלול…</div>' : '<div class="empty">לא זוהה דיבור בסרטון.</div>';
    renderStrip(); return;
  }
  const q = $('#search').value.trim().toLowerCase();
  box.innerHTML = '';
  for (const b of S.blocks) {
    const el = document.createElement('div');
    el.className = 'blk' + (q && b.text.toLowerCase().includes(q) ? ' hit' : '');
    el.dataset.id = b.id;
    const multi = settings.tracks.length > 1, T = settings.tracks[tr(b)] || settings.tracks[0];
    el.style.setProperty('--tc', T.color);
    el.innerHTML = `<div class="blk-top">${multi ? `<button class="tag" data-a="track" title="העברה לדובר אחר"></button>` : ''}<span class="tlbl">${fmt(b.start)} – ${fmt(b.end)}</span></div>
      <div class="blk-text" dir="auto" contenteditable="${S.busy ? 'false' : 'true'}" spellcheck="false"></div>
      <div class="blk-acts">
        <button data-a="play">▶ נגן</button>
        <button data-a="split" title="חיתוך השורה במקום של הסמן">✂ פצל</button>
        <button data-a="merge" title="איחוד עם השורה הבאה">⤓ אחד</button>
        <button data-a="add" title="הוספת שורה חדשה אחרי השורה הזו">➕ אחרי</button>
        <button data-a="del" class="del">🗑 מחק</button>
      </div>`;
    el.querySelector('.blk-text').textContent = b.text;
    if (multi) el.querySelector('.tag').textContent = '● ' + T.name;
    if (multi) el.classList.add('multi');
    box.appendChild(el);
  }
  lastCur = null; renderStrip(); updateTime();
}
const blocksBox = $('#blocks');
blocksBox.addEventListener('click', (e) => {
  const el = e.target.closest('.blk'); if (!el) return;
  const i = S.blocks.findIndex((b) => b.id === el.dataset.id), b = S.blocks[i];
  const a = e.target.closest('[data-a]') && e.target.closest('[data-a]').dataset.a;
  if (!a) { if (!e.target.closest('.blk-text')) { pause(); seek(b.start + 0.01); } return; }
  if (S.busy) return toast('אפשר לערוך אחרי שהתמלול יסתיים');
  if (a === 'play') { seek(b.start + 0.01); play(); stopAt = b.end; }
  else if (a === 'track') {
    // העברת השורה לדובר הבא; אם היא חופפת לשורה של הדובר החדש — מקצרים אותה
    const to = (tr(b) + 1) % settings.tracks.length, o = { start: b.start, end: b.end, track: tr(b) };
    b.track = to;
    const { prev, next } = neighbors(b);
    if (prev && prev.end > b.start) b.start = prev.end;
    if (next && next.start < b.end) b.end = next.start;
    if (b.end - b.start < 0.3) { Object.assign(b, o); return toast(`אין מקום אצל ${settings.tracks[to].name} בזמן הזה — יש שם כבר שורה`); }
    if (b.start !== o.start || b.end !== o.end) { rescaleWords(b, o); toast('השורה קוצרה כדי לא לחפוף לשורה אחרת של אותו דובר'); }
    S.activeTrack = to; renderTracksBar(); changed(true);
  } else if (a === 'merge') {
    const next = neighbors(b).next; if (!next) return toast('אין שורה הבאה לאותו דובר');
    b.text = (b.text + ' ' + next.text).trim(); b.end = next.end;
    b.words = b.words && next.words ? b.words.concat(next.words) : null;
    S.blocks.splice(S.blocks.indexOf(next), 1); changed(true);
  } else if (a === 'add') {
    const next = neighbors(b).next;
    const gapAfter = (next ? next.start : S.dur) - b.end;
    addBlockAt(gapAfter > 0.4 ? b.end : (b.start + b.end) / 2, tr(b));
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
    const nb = { id: uid(), start: mid, end: b.end, text: right, words: b.words ? b.words.slice(nLeft) : null, track: tr(b) };
    b.text = left; b.end = mid; b.words = b.words ? b.words.slice(0, nLeft) : null;
    S.blocks.splice(i + 1, 0, nb); changed(true);
  }
});
// הוספת שורה חדשה בנקודת זמן (למשל משפט שהתמלול פספס)
function addBlockAt(t, track = S.activeTrack) {
  if (!S.video) return;
  if (S.busy) return toast('אפשר להוסיף שורות אחרי שהתמלול יסתיים');
  pause();
  t = clamp(t, 0, S.dur);
  const mine = S.blocks.filter((b) => tr(b) === track); // רק השורות של הדובר הזה
  const cur = mine.find((b) => t >= b.start && t < b.end);
  let nb;
  if (cur) {
    // הסמן בתוך שורה קיימת של הדובר — מחלקים את הזמן שלה: הקיימת עד הסמן, החדשה מהסמן
    if (t - cur.start < 0.3) t = cur.start + (cur.end - cur.start) / 2;
    nb = { id: uid(), start: t, end: cur.end, text: '', words: null, track };
    cur.end = t;
  } else {
    // ברווח — שורה של עד 2.5 שניות, עד השורה הבאה של אותו דובר
    const next = mine.find((b) => b.start > t);
    nb = { id: uid(), start: t, end: Math.min(t + 2.5, next ? next.start : S.dur), text: '', words: null, track };
  }
  if (nb.end - nb.start < 0.3) return toast('אין כאן מקום לשורה — הזיזו קצת את הסרטון');
  S.blocks.push(nb); sortBlocks();
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
/* ---------- פס הזמן: גל קול + השורות, גרירת קצוות ---------- */
const strip = $('#strip'), stripInner = $('#strip-inner'), stripBlocks = $('#strip-blocks'), stripWave = $('#strip-wave');
let Z = 90;                 // פיקסלים לשנייה
let peaks = null;           // עוצמת הקול, 50 ערכים לשנייה
let stripDrag = false, progScrollAt = 0;
const PPS = 50;
const stripPad = () => strip.clientWidth / 2;
function computePeaks(pcm) {
  const step = 16000 / PPS, n = Math.ceil(pcm.length / step), p = new Float32Array(n); let max = 0.01;
  for (let i = 0; i < n; i++) { let m = 0; const s = i * step, e = Math.min(pcm.length, s + step); for (let k = s; k < e; k += 4) { const v = Math.abs(pcm[k]); if (v > m) m = v; } p[i] = m; if (m > max) max = m; }
  for (let i = 0; i < n; i++) p[i] /= max;
  peaks = p;
}
function drawWave() {
  stripWave.innerHTML = '';
  if (!peaks || !S.video) return;
  const P = stripPad(), total = Math.ceil(S.dur * Z), H = strip.clientHeight || 70, SEG = 4000;
  for (let x0 = 0; x0 < total; x0 += SEG) {
    const w = Math.min(SEG, total - x0), c = document.createElement('canvas');
    c.width = w; c.height = H; c.style.left = P + x0 + 'px'; c.style.width = w + 'px';
    const g = c.getContext('2d'); g.fillStyle = 'rgba(160, 170, 195, .38)';
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.floor((x0 + x) / Z * PPS)] || 0, h = Math.max(1, v * H * 0.8);
      g.fillRect(x, (H - h) / 2, 1, h);
    }
    stripWave.appendChild(c);
  }
}
function renderStrip() {
  if (!S.video) return;
  const P = stripPad(), n = settings.tracks.length;
  // כמה דוברים = כמה שורות בפס; הפס גדל בהתאם
  const rowH = n === 1 ? 0 : (matchMedia('(max-width: 860px)').matches ? 24 : 32);
  const wantH = n === 1 ? '' : 12 + n * rowH + 'px';
  if (strip.style.height !== wantH) { strip.style.height = wantH; }
  stripInner.style.width = S.dur * Z + 2 * P + 'px';
  stripBlocks.innerHTML = '';
  for (const b of S.blocks) {
    const el = document.createElement('div');
    el.className = 'sb' + (b === lastCur ? ' cur' : '') + (n > 1 && tr(b) === S.activeTrack ? ' act' : ''); el.dataset.id = b.id;
    el.style.setProperty('--tc', (settings.tracks[tr(b)] || settings.tracks[0]).color);
    if (n > 1) { el.style.top = 6 + tr(b) * rowH + 'px'; el.style.bottom = 'auto'; el.style.height = rowH - 4 + 'px'; }
    placeSb(el, b, P);
    el.innerHTML = '<div class="sb-h l" data-e="start" title="גררו לשינוי ההתחלה"></div><span></span><div class="sb-h r" data-e="end" title="גררו לשינוי הסוף"></div>';
    el.querySelector('span').textContent = b.text.trim() || '…';
    el.querySelector('span').dir = 'auto';
    stripBlocks.appendChild(el);
  }
  drawWave(); syncStrip(true);
}
function placeSb(el, b, P = stripPad()) { el.style.left = P + b.start * Z + 'px'; el.style.width = Math.max(8, (b.end - b.start) * Z) + 'px'; }
function syncStrip(force) {
  if (!S.video || stripDrag || pan || glide) return; // בזמן שהאצבע מזיזה את הפס — לא נלחמים בה
  const x = S.video.currentTime * Z;
  if (force || Math.abs(strip.scrollLeft - x) > 1) { progScrollAt = performance.now(); strip.scrollLeft = x; }
}
// החלקה על הפס = תזוזה בסרטון (הקו הצהוב באמצע הוא "עכשיו").
// חשוב: מגיבים רק לגלילה של אצבע/עכבר אמיתיים — לא לגלילה שהאתר עצמו עושה בזמן ניגון
// (אחרת, כשהטלפון עמוס, אירוע גלילה מאוחר היה עוצר את הסרטון ואת הייצוא).
// גרירה חופשית על כל הפס (גם על השורות): האצבע מזיזה את הפס, ושחרור עם תנופה ממשיך לגלוש
let pan = null, glide = 0, pendingSeek = null;
function scrubTo(t) {                      // הזזת הסרטון בלי "להיתקע": בקשה אחת בכל פעם, האחרונה מנצחת
  if (!S.video) return;
  pendingSeek = clamp(t, 0, S.dur);
  if (!S.video.seeking) { S.video.currentTime = pendingSeek; pendingSeek = null; }
}
function setStripPos(x) {
  x = clamp(x, 0, S.dur * Z);
  progScrollAt = performance.now(); strip.scrollLeft = x;
  scrubTo(x / Z);
}
function stopGlide() { if (glide) cancelAnimationFrame(glide); glide = 0; }
function startGlide(v) {                   // v = פיקסלים למילישנייה
  stopGlide();
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(40, now - last); last = now;
    v *= Math.pow(0.94, dt / 16);
    if (Math.abs(v) < 0.02) { glide = 0; return; }
    setStripPos(strip.scrollLeft + v * dt);
    glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}
strip.addEventListener('pointerdown', (e) => {
  if (S.exporting || e.target.closest('.sb-h') || e.target.closest('.strip-zoom') || (e.button && e.button > 0)) return;
  e.preventDefault();
  stopGlide();
  if (S.playing) pause();
  pan = { id: e.pointerId, x0: e.clientX, s0: strip.scrollLeft, lx: e.clientX, lt: performance.now(), v: 0, moved: false, target: e.target };
  try { strip.setPointerCapture(e.pointerId); } catch {}
});
strip.addEventListener('pointermove', (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  const dx = e.clientX - pan.x0;
  if (!pan.moved && Math.abs(dx) < 5) return;
  pan.moved = true;
  setStripPos(pan.s0 - dx);
  const now = performance.now(), dt = now - pan.lt;
  if (dt > 0) pan.v = 0.75 * pan.v + 0.25 * ((pan.lx - e.clientX) / dt);
  pan.lx = e.clientX; pan.lt = now;
});
const endPan = (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  const p = pan; pan = null;
  if (!p.moved) { // הקשה: קופצים לשורה שנלחצה, או לנקודה שנלחצה
    const sb = p.target.closest && p.target.closest('.sb');
    const b = sb && S.blocks.find((x) => x.id === sb.dataset.id);
    if (b) { seek(b.start + 0.01); scrollListTo(b); if (S.activeTrack !== tr(b)) { S.activeTrack = tr(b); renderTracksBar(); syncStyleUI(); renderStrip(); } }
    else { const r = strip.getBoundingClientRect(); seek((strip.scrollLeft + e.clientX - r.left - stripPad()) / Z); }
    return;
  }
  if (e.type === 'pointerup' && performance.now() - p.lt < 80 && Math.abs(p.v) > 0.1) startGlide(p.v);
};
strip.addEventListener('pointerup', endPan);
strip.addEventListener('pointercancel', endPan);
// גלגלת עכבר / משטח מגע במחשב — גלילה רגילה
let wheelUntil = 0;
strip.addEventListener('wheel', () => { if (!S.exporting) { stopGlide(); wheelUntil = performance.now() + 500; } }, { passive: true });
strip.addEventListener('scroll', () => {
  if (stripDrag || pan || glide || !S.video || S.exporting || performance.now() > wheelUntil) return;
  if (S.playing) pause();
  scrubTo(strip.scrollLeft / Z);
});
function setZoom(z) { Z = clamp(z, 20, 400); renderStrip(); }
$('#zoom-in').onclick = () => setZoom(Z * 1.5);
$('#zoom-out').onclick = () => setZoom(Z / 1.5);
// גרירת הקצוות של שורה
stripBlocks.addEventListener('pointerdown', (e) => {
  const sb = e.target.closest('.sb'); if (!sb) return;
  const i = S.blocks.findIndex((x) => x.id === sb.dataset.id), b = S.blocks[i]; if (!b) return;
  const edge = e.target.closest('.sb-h') && e.target.closest('.sb-h').dataset.e;
  const x0 = e.clientX;
  if (!edge) return; // לחיצה/גרירה על גוף השורה מטופלת בגרירת הפס
  if (S.busy) return toast('אפשר לערוך אחרי שהתמלול יסתיים');
  e.preventDefault(); e.stopPropagation();
  pause(); stripDrag = true; sb.classList.add('drag');
  try { sb.setPointerCapture(e.pointerId); } catch {}
  const { prev, next } = neighbors(b), o = { start: b.start, end: b.end }; // רק שורות של אותו דובר מגבילות
  const tip = $('#strip-tip'); let moved = false;
  const show = (t) => { tip.hidden = false; tip.textContent = (edge === 'start' ? 'התחלה ' : 'סוף ') + fmt(t, 2); };
  show(edge === 'start' ? b.start : b.end);
  const move = (ev) => {
    const dx = (ev.clientX - x0) / Z; if (Math.abs(ev.clientX - x0) > 2) moved = true;
    if (edge === 'start') { b.start = clamp(o.start + dx, prev ? prev.end : 0, b.end - 0.3); S.video.currentTime = b.start + 0.01; show(b.start); }
    else { b.end = clamp(o.end + dx, b.start + 0.3, next ? next.start : S.dur); S.video.currentTime = Math.max(b.start, b.end - 0.05); show(b.end); }
    placeSb(sb, b);
  };
  const end = () => {
    sb.removeEventListener('pointermove', move); sb.removeEventListener('pointerup', end); sb.removeEventListener('pointercancel', end);
    stripDrag = false; tip.hidden = true; sb.classList.remove('drag');
    if (moved) { rescaleWords(b, o); store.set('stripHintSeen', true); $('#strip-hint').hidden = true; changed(true); }
  };
  sb.addEventListener('pointermove', move); sb.addEventListener('pointerup', end); sb.addEventListener('pointercancel', end);
});
// כשמשנים זמנים של שורה — מתאימים את זמני המילים (בשביל הדגשת המילה)
function rescaleWords(b, o) {
  if (!b.words || !b.words.length) return;
  const k = (b.end - b.start) / Math.max(0.01, o.end - o.start);
  b.words = b.words.map((w) => ({ ...w, start: b.start + (w.start - o.start) * k, end: b.start + (w.end - o.start) * k }));
}
function scrollListTo(b) { const el = document.querySelector(`.blk[data-id="${b.id}"]`); if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
if (store.get('stripHintSeen', false)) $('#strip-hint').hidden = true;
window.addEventListener('resize', () => renderStrip());

function changed(rerender) { S.edited = true; if (rerender) renderBlocks(); draw(); save(); }
let saveT;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(save, 600); }
function save() {
  if (!S.key || !S.blocks.length) return;
  const data = { words: S.words, blocks: S.blocks, edited: S.edited, at: Date.now(), name: S.file && S.file.name, dur: S.dur, partial: !!S.busy };
  try { localStorage.setItem('subs.proj:' + S.key, JSON.stringify(data)); }
  catch { pruneProjects(5); try { localStorage.setItem('subs.proj:' + S.key, JSON.stringify(data)); } catch { toast('אין מקום לשמור בדפדפן — הורידו SRT כגיבוי', 5000); } }
  pruneProjects(25);
}
// שומרים רק את הפרויקטים האחרונים, כדי לא למלא את הזיכרון של הדפדפן
function listProjects() {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('subs.proj:')) { try { const p = JSON.parse(localStorage.getItem(k)); out.push({ k, ...p }); } catch {} } } } catch {}
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
function pruneProjects(keep) { listProjects().slice(keep).forEach((p) => { try { if (p.k !== 'subs.proj:' + S.key) localStorage.removeItem(p.k); } catch {} }); }
// מוצאים עבודה שמורה גם אם הגלריה נתנה לקובץ שם אחר (לפי גודל + אורך)
function findSaved(key) {
  const direct = store.get('proj:' + key, null); if (direct) return direct;
  const tail = key.slice(key.indexOf('|'));
  const hit = listProjects().find((p) => p.k.endsWith(tail));
  if (hit) { try { localStorage.removeItem(hit.k); } catch {} delete hit.k; return hit; }
  return null;
}
function renderRecent() {
  const box = $('#recent'); if (!box) return;
  const list = listProjects().slice(0, 5);
  box.hidden = !list.length;
  if (!list.length) return;
  box.innerHTML = '<div class="recent-title">להמשיך מאיפה שעצרת</div><p class="note">העבודה שמורה. בחרו שוב את אותו סרטון — הכתוביות והתיקונים ייטענו מעצמם.</p>';
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'recent-row';
    const when = new Date(p.at || 0).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
    const parts = p.k.slice('subs.proj:'.length).split('|'); // שם|גודל|אורך — לפרויקטים ששמרה גרסה ישנה
    row.innerHTML = '<span class="rn"></span><span class="rm"></span>';
    row.querySelector('.rn').textContent = p.name || parts[0] || 'סרטון';
    row.querySelector('.rm').textContent = `${fmt(p.dur || +parts[2] || 0, 0)} · ${(p.blocks || []).length} שורות · ${when}`;
    box.appendChild(row);
  }
}
$('#search').addEventListener('input', renderBlocks);

/* ---------- תמלול ---------- */
let worker = null, seq = 0;
function workerRun(audio, onEvent) {
  if (!worker) worker = new Worker('worker.js?v=202611142101', { type: 'module' });
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
    const pcm = (S.pcmP && await S.pcmP) || await decodePcm(S.file);
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
      S.blocks = groupWords(S.words, +settings.len); renderBlocks(); draw(); save();
    }
    }
    for (let i = 1; i < S.words.length; i++) if (S.words[i].start < S.words[i - 1].start) S.words[i].start = S.words[i - 1].start;
    S.blocks = groupWords(S.words, +settings.len);
    S.busy = false; txStatus(null); renderBlocks(); draw(); save();
    if (useServer()) refreshMe();
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
    if (res.status === 429) { refreshMe(); throw new Error(`הגעת למגבלת הדקות החודשית (${me ? me.limit_min : ''} דק׳). אפשר לבקש הגדלה ממי ששלח לך את ההזמנה`); }
    if (!res.ok) throw new Error('השרת החזיר שגיאה ' + res.status);
    const d = res.data;
    txStatus(`מתמלל… ${Math.round((pct + span) * 100)}%`, pct + span);
    const off = a / 16000;
    S.words.push(...cleanWords(d.words.map((w) => ({ text: w.text, start: off + w.start, end: off + w.end }))));
    S.blocks = groupWords(S.words, +settings.len); renderBlocks(); draw(); save();
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
  window.__justConnected = true;
})();

/* ---------- מי מחובר + שימוש ---------- */
let me = null; // {role:'admin'|'invite', name, month_min, limit_min}
async function api(path, opts = {}) {
  const r = await fetch(SERVER + path, { ...opts, headers: { 'x-kalil-key': serverKey(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  if (!r.ok) { const e = new Error('server ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function refreshMe() {
  if (!serverKey()) { me = null; return; }
  try { me = await api('/me'); }
  catch (e) {
    if (e.status === 401) { store.set('serverKey', ''); me = null; toast('הגישה לשרת התמלול הסתיימה — התמלול יחזור לרוץ על המכשיר', 6000); }
    return;
  }
  if (window.__justConnected) {
    window.__justConnected = false;
    toast(me.role === 'admin' ? 'המכשיר מחובר לשרת התמלול ✓' : `שלום ${me.name}! קיבלת גישה לתמלול מהיר ✓`, 6000);
  }
}
refreshMe();
function renderServerRow() {
  const on = !!serverKey();
  $('#server-row').hidden = !on;
  if (!on) return;
  const isAdmin = me && me.role === 'admin';
  $('#server-who').textContent = me ? (isAdmin ? '🟢 מחובר לשרת התמלול (מנהלת)' : `🟢 מחובר לשרת התמלול · ${me.name}`) : '🟢 המכשיר מחובר לשרת התמלול';
  $('#btn-invites').hidden = !isAdmin;
  const showUse = me && me.role === 'invite';
  $('#server-usage').hidden = !showUse;
  if (showUse) {
    $('#usage-bar').style.width = clamp(me.month_min / me.limit_min, 0, 1) * 100 + '%';
    $('#usage-txt').textContent = `${me.month_min} מתוך ${me.limit_min} דק׳ החודש`;
  }
}

/* ---------- ניהול הזמנות (מנהלת) ---------- */
const SITE = 'https://taltul1989.github.io/kalil-subs/';
const inviteLink = (key) => `${SITE}#key=${key}`;
let qrLib = null;
function loadQr() {
  if (!qrLib) qrLib = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  return qrLib;
}
const ago = (ts) => { if (!ts) return 'עוד לא השתמש/ה'; const d = (Date.now() / 1000 - ts) / 3600; return d < 1 ? 'השתמש/ה לפני פחות משעה' : d < 24 ? `השתמש/ה לפני ${Math.round(d)} שעות` : `השתמש/ה לפני ${Math.round(d / 24)} ימים`; };
async function openInvites() {
  $('#dlg-settings').close();
  $('#inv-new').hidden = true;
  $('#dlg-invites').showModal();
  await renderInviteList();
}
async function renderInviteList() {
  const box = $('#inv-list');
  box.innerHTML = '<div class="inv-empty">טוען…</div>';
  let list;
  try { list = (await api('/admin/invites')).invites; } catch { box.innerHTML = '<div class="inv-empty">לא הצלחתי לטעון את ההזמנות. בדקו את החיבור ונסו שוב.</div>'; return; }
  if (!list.length) { box.innerHTML = '<div class="inv-empty">עוד אין הזמנות. צרו את הראשונה למעלה.</div>'; return; }
  box.innerHTML = '';
  for (const inv of list) {
    const row = document.createElement('div');
    row.className = 'inv-row' + (inv.active ? '' : ' off');
    row.innerHTML = `<div class="nm"></div>
      <div class="meta"></div>
      <div class="acts">
        <select title="מגבלת דקות בחודש">${[30, 60, 120, 300].map((v) => `<option value="${v}" ${v === inv.limit_min ? 'selected' : ''}>${v} דק׳</option>`).join('')}</select>
        <button type="button" class="btn sm ${inv.active ? '' : 'primary'}">${inv.active ? 'ביטול גישה' : 'החזרת גישה'}</button>
        <button type="button" class="btn sm ghost" title="שליחה מחדש">📲</button>
      </div>`;
    row.querySelector('.nm').textContent = inv.name + (inv.active ? '' : ' (מבוטל)');
    row.querySelector('.meta').textContent = `${inv.month_min} / ${inv.limit_min} דק׳ החודש · ${ago(inv.last)}`;
    const [sel, toggle, resend] = row.querySelectorAll('select, button');
    sel.onchange = async () => { try { await api('/admin/invites/' + inv.key, { method: 'POST', body: JSON.stringify({ limit_min: +sel.value }) }); toast('המגבלה עודכנה'); renderInviteList(); } catch { toast('העדכון נכשל'); } };
    toggle.onclick = async () => {
      if (inv.active && !confirm(`לבטל את הגישה של ${inv.name}? הקישור שלו/ה יפסיק לעבוד (אפשר להחזיר אחר כך).`)) return;
      try { await api('/admin/invites/' + inv.key, { method: 'POST', body: JSON.stringify({ active: !inv.active }) }); renderInviteList(); } catch { toast('העדכון נכשל'); }
    };
    resend.onclick = () => showNewInvite(inv);
    box.appendChild(row);
  }
}
async function showNewInvite(inv) {
  $('#inv-new').hidden = false;
  $('#inv-new-name').textContent = inv.name;
  const link = inviteLink(inv.key), qr = $('#inv-qr');
  qr.innerHTML = '';
  try { await loadQr(); new window.QRCode(qr, { text: link, width: 200, height: 200 }); } catch { qr.textContent = link; }
  const msg = `היי ${inv.name}! הזמנתי אותך לנסות את "קליל כתוביות" — כתוביות אוטומטיות בעברית לסרטונים. פשוט פותחים את הקישור (עדיף ב-Chrome):`;
  $('#inv-share').onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'קליל כתוביות', text: msg, url: link }); } catch {} }
    else { window.open('https://wa.me/?text=' + encodeURIComponent(msg + '\n' + link), '_blank'); }
  };
  $('#inv-copy').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('הקישור הועתק ✓'); } catch { prompt('העתיקו את הקישור:', link); } };
  $('#inv-new').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('#inv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#inv-name').value.trim(); if (!name) return;
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const inv = await api('/admin/invites', { method: 'POST', body: JSON.stringify({ name, limit_min: +$('#inv-limit').value }) });
    $('#inv-name').value = '';
    await showNewInvite(inv); renderInviteList();
  } catch { toast('לא הצלחתי ליצור הזמנה. נסו שוב'); }
  finally { if (btn) btn.disabled = false; }
});
$('#btn-invites').onclick = openInvites;
$('#inv-close').onclick = () => $('#dlg-invites').close();

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
  stopAt = null;
  S.video.play(); frameLoop();
  // שומר: אם הסרטון נעצר באמצע ההורדה — מפעילים מחדש; אם הוא תקוע לגמרי — הודעה ברורה במקום המתנה אינסופית
  let lastT = -1, still = 0;
  S.exporting.watch = setInterval(() => {
    const ex = S.exporting; if (!ex) return;
    const v = S.video;
    if (v.ended) return;
    if (v.paused) v.play().catch(() => {});
    if (Math.abs(v.currentTime - lastT) < 0.05) still++; else still = 0;
    lastT = v.currentTime;
    if (still >= 12) { ex.cancelled = true; ex.failed = true; v.pause(); finishExport(); }
  }, 1000);
}
function finishExport() {
  const ex = S.exporting; if (!ex) return;
  clearInterval(ex.watch);
  S.exporting = null; speaker.gain.value = 1;
  try { ex.lock && ex.lock.release(); } catch {}
  ex.rec.onstop = async () => {
    if (ex.cancelled) {
      $('#export-overlay').hidden = true;
      return toast(ex.failed ? 'ההורדה נתקעה ונעצרה. העבודה שלך שמורה — נסו שוב, או הורידו קובץ SRT' : 'בוטל', ex.failed ? 7000 : 2800);
    }
    const ext = ex.mime.includes('mp4') ? 'mp4' : 'webm';
    const base = S.file.name.replace(/\.[^.]+$/, '');
    const name = `${base}-כתוביות.${ext}`;
    let blob = new Blob(ex.chunks, { type: ex.mime.split(';')[0] });
    if (ext === 'mp4') { try { blob = await fixMp4Duration(blob, S.dur); } catch (e) { console.warn('duration fix failed', e); } }
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
/* הדפדפן כותב את הסרטון בחתיכות (fragmented MP4) ולא מעדכן את האורך בכותרת הקובץ.
   נגנים מחשבים לבד, אבל הגלריה ורשימת ההורדות מציגות אורך שגוי. כאן כותבים את האורך האמיתי
   לתוך התיבות mvhd / tkhd / mdhd / mehd שבתחילת הקובץ (בלי לגעת בווידאו עצמו). */
async function fixMp4Duration(blob, seconds) {
  const headLen = Math.min(blob.size, 4 * 1024 * 1024);
  const head = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
  const dv = new DataView(head.buffer);
  const type = (o) => String.fromCharCode(head[o + 4], head[o + 5], head[o + 6], head[o + 7]);
  let movieScale = 0, patched = 0;
  const setDur = (o, ver, val) => { // o = מיקום שדה הזמן
    if (ver === 1) dv.setBigUint64(o, BigInt(Math.round(val)));
    else dv.setUint32(o, Math.min(0xffffffff, Math.round(val)));
    patched++;
  };
  const walk = (start, end) => {
    for (let o = start; o + 8 <= end;) {
      let size = dv.getUint32(o), hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
      else if (size === 0) size = end - o;
      if (size < 8 || o + size > head.length) { // תיבה שחורגת מהחלק שקראנו (למשל mdat) — זה בסדר, מדלגים
        if (type(o) === 'moov') throw new Error('moov too big');
        return;
      }
      const t = type(o), b = o + hdr, ver = head[b];
      if (t === 'moov' || t === 'trak' || t === 'mdia' || t === 'mvex') walk(b, o + size);
      else if (t === 'mvhd') { const s = ver === 1 ? 20 : 12; movieScale = dv.getUint32(b + s); setDur(b + s + 4, ver, seconds * movieScale); }
      else if (t === 'tkhd' && movieScale) setDur(b + (ver === 1 ? 28 : 20), ver, seconds * movieScale);
      else if (t === 'mdhd') { const s = ver === 1 ? 20 : 12; setDur(b + s + 4, ver, seconds * dv.getUint32(b + s)); }
      else if (t === 'mehd' && movieScale) setDur(b + 4, ver, seconds * movieScale);
      if (t === 'moof' || t === 'mdat') return; // הגענו לחתיכות הווידאו — הכותרת נגמרה
      o += size;
    }
  };
  walk(0, head.length);
  if (!patched) return blob;
  return new Blob([head, blob.slice(headLen)], { type: blob.type });
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
// העיצוב חל על הדובר שנבחר בכפתורי הדוברים
const segSyncs = [];
function bindSeg(id, key) {
  const seg = $(id);
  const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(curTrack()[key])));
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; curTrack()[key] = b.dataset.v; saveSettings(); sync(); draw(); });
  segSyncs.push(sync);
}
bindSeg('#style-seg', 'style'); bindSeg('#pos-seg', 'pos');
$('#color-seg').innerHTML = TRACK_COLORS.map((c) => `<button type="button" data-c="${c}" style="--c:${c}" aria-label="צבע"></button>`).join('');
$('#color-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  curTrack().color = b.dataset.c; saveSettings(); syncStyleUI(); renderTracksBar(); renderBlocks(); draw();
});
$('#size').oninput = (e) => { curTrack().size = +e.target.value; saveSettings(); draw(); };
$('#karaoke').onchange = (e) => { curTrack().karaoke = e.target.checked; saveSettings(); draw(); };
function syncStyleUI() {
  const T = curTrack();
  segSyncs.forEach((f) => f());
  $('#color-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c.toUpperCase() === (T.color || '').toUpperCase()));
  $('#size').value = T.size; $('#karaoke').checked = T.karaoke !== false;
  $('#style-for').textContent = settings.tracks.length > 1 ? ` · ${T.name}` : '';
}

/* ---------- כפתורי הדוברים: בחירה, הוספה (+), שינוי שם, מחיקה ---------- */
function renderTracksBar() {
  const bar = $('#tracks-bar'); if (!bar) return;
  bar.innerHTML = '';
  settings.tracks.forEach((T, i) => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'tchip' + (i === S.activeTrack ? ' on' : '');
    chip.style.setProperty('--tc', T.color);
    chip.innerHTML = '<span class="dot"></span><span class="tn"></span>' + (i === S.activeTrack ? '<span class="ted" title="שינוי שם">✎</span>' + (i > 0 ? '<span class="tdel" title="הסרת הדובר">✕</span>' : '') : '');
    chip.querySelector('.tn').textContent = T.name;
    chip.onclick = (e) => {
      if (e.target.closest('.ted')) return renameTrack(i);
      if (e.target.closest('.tdel')) return removeTrack(i);
      S.activeTrack = i; renderTracksBar(); syncStyleUI(); renderStrip();
    };
    bar.appendChild(chip);
  });
  if (settings.tracks.length < 4) {
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'tchip add'; add.textContent = settings.tracks.length === 1 ? '＋ דובר נוסף' : '＋';
    add.title = 'הוספת טיימליין לדובר נוסף';
    add.onclick = () => {
      S.activeTrack = newTrack(); renderTracksBar(); syncStyleUI(); renderBlocks(); draw();
      toast(`נוסף ${curTrack().name} ✓ "➕ שורה" מוסיף עכשיו שורות שלו, ובכל שורה ברשימה אפשר ללחוץ על שם הדובר כדי להעביר אותה`, 6000);
    };
    bar.appendChild(add);
  }
}
function renameTrack(i) {
  const name = prompt('שם הדובר (למשל: דנה, מראיין):', settings.tracks[i].name);
  if (name == null) return;
  settings.tracks[i].name = name.trim().slice(0, 20) || settings.tracks[i].name;
  saveSettings(); renderTracksBar(); syncStyleUI(); renderBlocks();
}
function removeTrack(i) {
  const T = settings.tracks[i], n = S.blocks.filter((b) => tr(b) === i).length;
  if (!confirm(n ? `להסיר את ${T.name}? ${n} השורות שלו יעברו ל${settings.tracks[0].name}.` : `להסיר את ${T.name}?`)) return;
  // שורות של הדובר עוברות לדובר 1 (אם יש חפיפה — מקצרים / מוחקים שורה ריקה)
  for (const b of S.blocks) { if (tr(b) === i) b.track = 0; else if (tr(b) > i) b.track = tr(b) - 1; }
  settings.tracks.splice(i, 1); saveSettings();
  sortBlocks();
  const zero = S.blocks.filter((b) => tr(b) === 0);
  for (let k = 1; k < zero.length; k++) if (zero[k].start < zero[k - 1].end) zero[k - 1].end = Math.max(zero[k - 1].start + 0.1, zero[k].start);
  S.activeTrack = 0; renderTracksBar(); syncStyleUI(); changed(true);
}
renderTracksBar(); syncStyleUI();
$('#len').value = settings.len;
$('#len').onchange = (e) => {
  if (S.edited && !confirm('שינוי אורך השורה יבנה את הכתוביות מחדש מהתמלול, והתיקונים שעשיתם יימחקו. להמשיך?')) { e.target.value = settings.len; return; }
  settings.len = +e.target.value; saveSettings(); if (S.words.length && !S.busy) { S.edited = false; regroup(); }
};

/* ---------- הגדרות ---------- */
$('#btn-settings').onclick = () => {
  $('#set-lang').value = settings.lang; $('#set-model').value = settings.model;
  $('#set-engine').value = settings.engine;
  renderServerRow(); refreshMe().then(renderServerRow);
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
  resetVideo(); S.key = ''; $('#editor').hidden = true; $('#start').hidden = false; $('#btn-new').hidden = true; renderRecent();
};
/* ---------- לשוניות בטלפון: כתוביות / עיצוב (הטיימליין תמיד גלוי מעליהן) ---------- */
function setMTab(tab) {
  $('#editor').dataset.mtab = tab;
  document.querySelectorAll('#mtabs button').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  if (tab === 'style') $('.style-box').open = true;
}
$('#mtabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'btn-add2') { setMTab('subs'); return addBlockAt(S.video ? S.video.currentTime : 0); }
  setMTab(b.dataset.tab);
});
// בטלפון ההסבר על הטיימליין מופיע פעם אחת כהודעה, ולא תופס מקום קבוע
function mobileHintOnce() {
  if (!matchMedia('(max-width: 860px)').matches || store.get('stripHintSeen', false)) return;
  store.set('stripHintSeen', true);
  setTimeout(() => toast('טיפ: גוררים את הטיימליין כדי לזוז בסרטון, ואת הידיות ◀▶ בקצוות של שורה כדי לשנות מתי היא מתחילה ונגמרת', 7000), 1200);
}

/* ---------- מסך מלא לצפייה בסרטון ---------- */
const wrapEl = $('#screen-wrap');
const isFull = () => document.fullscreenElement === wrapEl || wrapEl.classList.contains('fake-full');
async function enterFull() {
  try {
    if (!wrapEl.requestFullscreen) throw new Error('no fullscreen');
    // אם הדפדפן לא עונה תוך שנייה וחצי — עוברים לחלופה
    await Promise.race([wrapEl.requestFullscreen({ navigationUI: 'hide' }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
    if (document.fullscreenElement !== wrapEl) throw new Error('not full');
    // סרטון רוחבי — מסובבים לרוחב
    if (S.video && S.video.videoWidth > S.video.videoHeight && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch { wrapEl.classList.add('fake-full'); document.body.style.overflow = 'hidden'; } // דפדפן בלי מסך מלא (למשל אייפון)
  syncFullBtn();
}
async function exitFull() {
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  wrapEl.classList.remove('fake-full'); document.body.style.overflow = '';
  try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch {}
  syncFullBtn();
}
function syncFullBtn() { const f = isFull(); $('#btn-full').textContent = f ? '✕' : '⛶'; $('#btn-full').title = f ? 'יציאה ממסך מלא' : 'מסך מלא'; setTimeout(draw, 50); }
$('#btn-full').onclick = (e) => { e.stopPropagation(); isFull() ? exitFull() : enterFull(); };
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) wrapEl.classList.remove('fake-full'); syncFullBtn(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && wrapEl.classList.contains('fake-full')) exitFull(); });

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

renderRecent();
window.__subs = { S, loadFile, settings };
