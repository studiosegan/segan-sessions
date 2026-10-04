// app.js — wires modes, transport, header status, takes list.
import * as api from './api.js';
import { RATIOS } from './overlay.js';
import { createCameraMode } from './camera.js';
import { createCompositeMode } from './composite.js';
import { createPhoneMode } from './phone.js';
import { createTeleprompter } from './teleprompter.js';
import { createMicMeter } from './meter.js';
import { logEvent, logError, installGlobalHandlers } from './log.js';

const $ = (id) => document.getElementById(id);
const els = {
  ratio: $('sel-ratio'), transportRatio: $('transport-ratio'),
  record: $('btn-record'), retake: $('btn-retake'), pause: $('btn-pause'), cancel: $('btn-cancel'),
  timer: $('rec-timer'), countdown: $('countdown'),
  mute: $('btn-mute'), muteBadge: $('mute-badge'),
  tabs: [...document.querySelectorAll('.tab')],
  panels: { camera: $('panel-camera'), composite: $('panel-composite'), phone: $('panel-phone') },
  takesList: $('takes-list'), takesCount: $('takes-count'),
  toast: $('toast'),
  pills: { ffmpeg: $('pill-ffmpeg'), phone: $('pill-phone'), disk: $('pill-disk') },
};

// ---------- shared context passed to modes ----------
let reelDefault = null;
let toastTimer = null;

const ctx = {
  getRatio: () => els.ratio.value,
  getReel: () => reelDefault,
  setReelDefault: (slug) => { reelDefault = slug; },
  setReady(ready) { if (!state.recording) els.record.disabled = !ready; },
  toast(msg, isError = false) {
    els.toast.textContent = msg;
    els.toast.className = `toast${isError ? ' error' : ''}`;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 6000 : 4000);
  },
  refreshTakes: () => renderTakes(),
  setPhonePill(s) {
    els.pills.phone.className = 'pill' + (s.connected && s.authorized ? ' ok' : s.connected ? ' warn' : '');
  },
  stopFromUi() { if (state.recording) toggleRecord(); },
  isRecording: () => state.recording && !state.paused, // paused = mic silence is expected
  recElapsed: () => (state.recording ? Math.floor((Date.now() - state.startedAt) / 1000) : 0),
  // the pop-out monitor's Record button: start instantly (no countdown — you're already
  // popped out and about to click away, and a hidden-tab countdown would freeze)
  monitorToggleRecord() { if (!state.recording) state.skipCountdown = true; toggleRecord(); },
  isMicMuted: () => state.micMuted,
  toggleMicMute: () => setMicMuted(!state.micMuted), // the pop-out monitor's mute button + M key
};
ctx.meter = createMicMeter(ctx);

const modes = {
  camera: createCameraMode(ctx),
  composite: createCompositeMode(ctx),
  phone: createPhoneMode(ctx),
};
const prompter = createTeleprompter(ctx);

const state = { mode: null, recording: false, paused: false, pausedAt: 0, timerInt: null, startedAt: 0, micMuted: false };

// ---------- mode switching ----------
async function setMode(name) {
  if (state.recording) return ctx.toast('Stop recording before switching modes', true);
  if (state.mode) modes[state.mode].deactivate();
  state.mode = name;
  els.tabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === name));
  Object.entries(els.panels).forEach(([k, p]) => { p.hidden = k !== name; });
  $('field-mic').hidden = name === 'phone'; // phone recordings use the phone's own audio
  els.mute.hidden = name === 'phone';
  els.muteBadge.hidden = !state.micMuted || name === 'phone';
  els.record.disabled = true;
  localStorage.setItem('ss-mode', name);
  await modes[name].activate();
}
els.tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));

// ---------- ratio ----------
function updateRatioLabel() {
  const r = RATIOS[els.ratio.value];
  els.transportRatio.textContent = `${els.ratio.value} · ${r.out}`;
}
els.ratio.addEventListener('change', () => {
  localStorage.setItem('ss-ratio', els.ratio.value);
  updateRatioLabel();
  modes[state.mode]?.onRatioChange?.();
});

// ---------- record / stop ----------
function countdown(n = 3) {
  return new Promise((resolve) => {
    els.countdown.hidden = false;
    const step = (i) => {
      if (i === 0) { els.countdown.hidden = true; return resolve(); }
      els.countdown.innerHTML = `<span>${i}</span>`;
      setTimeout(() => step(i - 1), 900);
    };
    step(n);
  });
}

function tickTimer() {
  const s = Math.floor((Date.now() - state.startedAt) / 1000);
  els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  // reel spec is 30–60s: amber when close, red when over
  els.timer.classList.toggle('warn45', s > 45 && s <= 60);
  els.timer.classList.toggle('over60', s > 60);
}
function startTimer() {
  state.startedAt = Date.now();
  els.timer.classList.add('live');
  state.timerInt = setInterval(tickTimer, 250);
}
function stopTimer() {
  clearInterval(state.timerInt);
  els.timer.classList.remove('live', 'warn45', 'over60', 'paused');
  els.timer.textContent = '00:00';
}

// controls that must not change mid-take (device swap kills the recorded tracks;
// ratio change resizes the encoding canvas)
const REC_LOCKED_IDS = ['sel-ratio', 'sel-cam', 'sel-mic', 'btn-pick-screen', 'sel-fit',
  'sel-main-source', 'sel-bubble-source', 'btn-bubble-pick', 'btn-repick-audio'];
function setRecordingLocks(on) {
  els.tabs.forEach((t) => { t.disabled = on; });
  REC_LOCKED_IDS.forEach((id) => { const el = $(id); if (el) el.disabled = on; });
}

async function toggleRecord() {
  if (state.busy) return; // synchronous re-entry guard (double-click, stopFromUi race)
  state.busy = true;
  try { await doToggleRecord(); } finally { state.busy = false; }
}

async function doToggleRecord() {
  const mode = modes[state.mode];
  if (!state.recording) {
    try {
      const { freeGB } = await api.getDisk().catch(() => ({ freeGB: null }));
      if (freeGB !== null && freeGB < 2) return ctx.toast(`Only ${freeGB} GB free — clear disk space first`, true);
      els.record.disabled = true;
      const cd = Number(localStorage.getItem('ss-countdown') ?? 3);
      if (state.mode !== 'phone' && cd > 0 && !state.skipCountdown) await countdown(cd);
      state.skipCountdown = false;
      await mode.start();
      state.recording = true;
      els.record.disabled = false;
      els.record.classList.add('recording');
      els.retake.hidden = !mode.cancel;
      els.cancel.hidden = !mode.cancel;
      els.pause.hidden = !mode.pause; // phone/scrcpy can't pause
      setRecordingLocks(true);
      startTimer();
      prompter.onRecordStart(); // rewind + start scrolling with the take
      if (state.micMuted && state.mode !== 'phone') {
        ctx.toast('Recording with your mic MUTED — your voice is not in this take. Press M to unmute.', true);
      }
    } catch (e) {
      logError('record.start', e, { mode: state.mode });
      els.record.disabled = false;
      els.countdown.hidden = true;
      ctx.toast(e.message, true);
    }
  } else {
    try {
      els.record.disabled = true;
      if (state.paused) mode.resume?.(); // a paused MediaRecorder still stops cleanly, but be explicit
      const recordedSec = Math.floor((Date.now() - state.startedAt) / 1000);
      const take = await mode.stop();
      // freeze guard: if the saved video is far shorter than the timer ran, the canvas
      // stalled — almost always because the studio tab was hidden mid-record.
      if (take?.duration != null && recordedSec > 4 && take.duration < recordedSec * 0.5) {
        logError('freeze-guard', new Error('recording froze'), { savedSec: take.duration, timerSec: recordedSec, device: take.device, file: take.file });
        ctx.toast(`⚠ Recording froze — only ${Math.round(take.duration)}s of ${recordedSec}s saved (details in the session log). If you had a background/zoom on a single window, capture the whole screen instead for now.`, true);
      } else if (take) {
        ctx.toast(`Saved ${take.file.split('/').pop()}`);
      }
      renderTakes();
      setTakesOpen(true);
    } catch (e) {
      logError('record.stop', e, { mode: state.mode });
      ctx.toast(`Save failed: ${e.message}`, true);
    } finally {
      state.recording = false;
      resetPauseUi();
      els.record.disabled = false;
      els.record.classList.remove('recording');
      els.retake.hidden = true;
      els.cancel.hidden = true;
      setRecordingLocks(false);
      stopTimer();
      prompter.onRecordStop();
    }
  }
}
els.record.addEventListener('click', () => {
  els.record.blur(); // space bar must drive the prompter, not re-trigger this button
  toggleRecord();
});

// ---------- mic mute: your voice only — the video and the call audio keep recording ----------
// Never saved: every session starts unmuted, so a forgotten mute can't eat tomorrow's take.
// Separate from Meet/Zoom's own mute in BOTH directions: muting in the meeting does not take
// your voice out of this recording, and muting here does not mute you in the meeting.
function setMicMuted(muted) {
  if (state.mode === 'phone') return; // phone recordings use the phone's own audio
  state.micMuted = muted;
  modes[state.mode]?.setMicMuted?.(muted);
  els.mute.classList.toggle('muted', muted);
  els.mute.setAttribute('aria-pressed', String(muted));
  els.mute.title = muted
    ? 'Your mic is MUTED — click or press M to unmute'
    : 'Mute your mic in the recording — the video and call audio keep recording (M)';
  els.muteBadge.hidden = !muted;
  ctx.meter?.setMuted(muted);
  logEvent('mic-mute', { muted, recording: state.recording, mode: state.mode });
  ctx.toast(muted ? 'Mic muted — your voice is not being recorded' : 'Mic on');
}
els.mute.addEventListener('click', () => {
  els.mute.blur(); // M / space must not re-trigger the focused button
  setMicMuted(!state.micMuted);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'm' && e.key !== 'M') return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target; // never steal the letter m from typing (or from a select's type-ahead)
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  setMicMuted(!state.micMuted);
});

// ---------- pause / resume within a take ----------
function resetPauseUi() {
  state.paused = false;
  els.pause.hidden = true;
  els.pause.classList.remove('paused'); // CSS swaps the ⏸/▶ icon off this class
  els.record.classList.remove('paused');
  els.timer.classList.remove('paused');
}

function togglePause() {
  const mode = modes[state.mode];
  if (!state.recording || state.busy || !mode.pause) return;
  state.paused = !state.paused;
  if (state.paused) {
    mode.pause();
    state.pausedAt = Date.now();
    clearInterval(state.timerInt); // freeze the clock where it is
    prompter.setPlaying(false);
    ctx.toast('Paused — same take continues when you resume');
  } else {
    mode.resume();
    state.startedAt += Date.now() - state.pausedAt; // paused time doesn't count
    state.timerInt = setInterval(tickTimer, 250);
    prompter.setPlaying(true);
  }
  els.pause.classList.toggle('paused', state.paused); // CSS swaps the ⏸/▶ icon
  els.record.classList.toggle('paused', state.paused);
  els.timer.classList.toggle('paused', state.paused);
}
els.pause.addEventListener('click', () => {
  els.pause.blur();
  togglePause();
});

// ---------- cancel: discard the rolling take and go back to idle ----------
async function cancelTake() {
  const mode = modes[state.mode];
  if (!state.recording || state.busy || !mode.cancel) return;
  if (!confirm('Throw this recording away? Nothing will be saved.')) return;
  state.busy = true;
  try {
    stopTimer();
    prompter.onRecordStop();
    await mode.cancel();
    ctx.toast('Recording cancelled — nothing saved');
  } catch (e) {
    ctx.toast(`Cancel hiccup (nothing saved): ${e.message}`, true);
  } finally {
    state.recording = false;
    resetPauseUi();
    els.record.disabled = false;
    els.record.classList.remove('recording');
    els.retake.hidden = true;
    els.cancel.hidden = true;
    setRecordingLocks(false);
    state.busy = false;
  }
}
els.cancel.addEventListener('click', () => {
  els.cancel.blur();
  cancelTake();
});

// ---------- retake: discard the rolling take, re-roll immediately ----------
async function retake() {
  if (!state.recording || state.busy) return;
  state.busy = true;
  const mode = modes[state.mode];
  els.record.disabled = true;
  els.retake.disabled = true;
  try {
    stopTimer();
    prompter.onRecordStop();
    await mode.cancel();
    state.recording = false;
    resetPauseUi();
    ctx.toast('Take discarded — rolling again');
    const cd = Number(localStorage.getItem('ss-countdown') ?? 3);
    if (state.mode !== 'phone' && cd > 0) await countdown(cd);
    await mode.start();
    state.recording = true;
    els.pause.hidden = !mode.pause;
    startTimer();
    prompter.onRecordStart();
  } catch (e) {
    // couldn't re-roll — fall back to a clean idle state, nothing was saved
    state.recording = false;
    resetPauseUi();
    els.record.classList.remove('recording');
    els.retake.hidden = true;
    els.cancel.hidden = true;
    els.countdown.hidden = true;
    setRecordingLocks(false);
    stopTimer();
    ctx.toast(`Retake failed: ${e.message}`, true);
  } finally {
    els.record.disabled = false;
    els.retake.disabled = false;
    state.busy = false;
  }
}
els.retake.addEventListener('click', () => {
  els.retake.blur();
  retake();
});

// ---------- takes list ----------
const MODE_LABEL = {
  camera: 'camera', screen: 'screen', 'phone-camera': 'phone cam',
  'phone-screen': 'phone screen', 'phone-pull': 'phone app',
};

function takeRow(t) {
  const row = document.createElement('div');
  row.className = `take ${t.status}`;
  const mb = t.size_bytes ? (t.size_bytes / 1048576).toFixed(1) + ' MB' : '';
  const dur = t.duration ? `${t.duration}s` : '';
  row.innerHTML = `
    <span class="status-dot" title="${t.status}"></span>
    <span class="name">${t.file.split('/').pop()}</span>
    <span class="badge">${MODE_LABEL[t.mode] || t.mode}</span>
    <span class="badge">${t.ratio}</span>
    ${t.reel ? `<span class="badge">${t.reel}</span>` : ''}
    <span class="meta">${[t.resolution, dur, mb].filter(Boolean).join(' · ')}</span>
    <span class="actions">
      <button class="btn quiet" data-act="folder" title="Reveal THIS file in Finder">📂 Folder</button>
      <button class="btn quiet" data-act="preview">Preview</button>
      ${t.status === 'raw' ? '<button class="btn quiet" data-act="finish">Finish</button>' : ''}
      <button class="btn danger" data-act="delete">Delete</button>
    </span>`;
  row.querySelector('[data-act="preview"]').onclick = () => {
    const open = row.querySelector('.take-preview');
    if (open) { open.remove(); return; }
    const box = document.createElement('div');
    box.className = 'take-preview';
    const which = t.status === 'finished' ? '?which=finished' : '';
    box.innerHTML = `<video controls src="/api/takes/${t.id}/file${which}"></video>`;
    row.appendChild(box);
  };
  row.querySelector('[data-act="finish"]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Finishing…';
    try { await api.finishTake(t.id); ctx.toast('Finished ✓'); renderTakes(); }
    catch (err) { ctx.toast(err.message, true); e.target.disabled = false; e.target.textContent = 'Finish'; }
  });
  row.querySelector('[data-act="folder"]').onclick = async () => {
    try { await api.revealTake(t.id); } // open -R this exact file in Finder → drag into the editor
    catch (err) { ctx.toast(err.message, true); }
  };
  row.querySelector('[data-act="delete"]').onclick = async () => {
    if (!confirm(`Delete ${t.file.split('/').pop()}?`)) return;
    try { await api.deleteTake(t.id); renderTakes(); } catch (err) { ctx.toast(err.message, true); }
  };
  return row;
}

async function renderTakes() {
  try {
    const { takes } = await api.getManifest();
    els.takesCount.textContent = takes.length ? `(${takes.length})` : '';
    els.takesList.innerHTML = '';
    if (!takes.length) {
      els.takesList.innerHTML = '<div class="takes-empty">No takes yet — hit the red button.</div>';
      return;
    }
    [...takes].reverse().forEach((t) => els.takesList.appendChild(takeRow(t)));
  } catch (e) {
    els.takesList.innerHTML = `<div class="takes-empty">Couldn't load takes: ${e.message}</div>`;
  }
}
$('btn-takes-refresh').addEventListener('click', (e) => { e.stopPropagation(); renderTakes(); });
$('btn-takes-folder').addEventListener('click', async (e) => {
  e.stopPropagation();
  // header button opens the footage folder (Camera/, Screen/, Phone/ …); per-row 📂 reveals one file
  try { await api.revealTake(); } catch (err) { ctx.toast(err.message, true); }
});
$('btn-images-folder').addEventListener('click', async (e) => {
  e.stopPropagation();
  // Photos never enter the manifest, so they get no Takes row and no per-row 📂. This is the
  // only route to them in the whole app — without it a pulled photo looks like it vanished.
  try { await api.revealDir('images'); } catch (err) { ctx.toast(err.message, true); }
});
$('btn-takes-clear').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!confirm('Delete ALL takes — the video files AND the history? This cannot be undone.')) return;
  try { const r = await api.clearTakes(); ctx.toast(`Cleared ${r.cleared} take(s)`); renderTakes(); }
  catch (err) { ctx.toast(err.message, true); }
});

// collapsible takes drawer — keeps the canvas viewport-fixed; opens after each save
function setTakesOpen(open) {
  $('takes').classList.toggle('open', open);
  els.takesList.hidden = !open;
}
$('takes-toggle').addEventListener('click', () => setTakesOpen(els.takesList.hidden));
$('takes-toggle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTakesOpen(els.takesList.hidden); }
});

// ---------- header status ----------
async function refreshHealth() {
  try {
    const h = await api.getHealth();
    els.pills.ffmpeg.className = 'pill' + (h.ffmpeg ? ' ok' : ' err');
    if (!h.scrcpy) els.pills.phone.title = 'scrcpy not found — re-run the installer (it brings scrcpy + adb)';
    const v = document.getElementById('app-version');
    if (v && h.version) v.textContent = `v${h.version}`;
  } catch {
    els.pills.ffmpeg.className = 'pill err';
  }
}
async function refreshDisk() {
  try {
    const { freeGB } = await api.getDisk();
    if (freeGB == null) {
      els.pills.disk.className = 'pill warn';
      els.pills.disk.innerHTML = '<span class="dot"></span>disk ?';
      return;
    }
    els.pills.disk.className = 'pill' + (freeGB < 2 ? ' err' : freeGB < 10 ? ' warn' : ' ok');
    els.pills.disk.innerHTML = `<span class="dot"></span>${freeGB} GB free`;
  } catch {}
}

// ---------- tips visibility (persisted) ----------
const hintsBtn = $('btn-hints');
function applyHints() {
  const on = localStorage.getItem('ss-hints') !== 'off';
  document.body.classList.toggle('hide-hints', !on);
  hintsBtn.classList.toggle('active', on);
}
hintsBtn.addEventListener('click', () => {
  localStorage.setItem('ss-hints', localStorage.getItem('ss-hints') === 'off' ? 'on' : 'off');
  applyHints();
});
applyHints();

// ---------- sidebar visibility (persisted) ----------
const railBtn = $('btn-rail');
function applyRail() {
  const hidden = localStorage.getItem('ss-rail') === 'hidden';
  document.body.classList.toggle('rail-hidden', hidden);
  railBtn.classList.toggle('active', !hidden);
}
railBtn.addEventListener('click', () => {
  localStorage.setItem('ss-rail', localStorage.getItem('ss-rail') === 'hidden' ? 'shown' : 'hidden');
  applyRail();
});
applyRail();

// ---------- theme (system / light / dark, persisted) ----------
const themeButtons = [...document.querySelectorAll('[data-theme-pref]')];
const themeMedia = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const pref = localStorage.getItem('ss-theme') || 'system';
  const dark = pref === 'dark' || (pref === 'system' && themeMedia.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  themeButtons.forEach((b) => b.classList.toggle('active', b.dataset.themePref === pref));
}
themeButtons.forEach((b) => b.addEventListener('click', () => {
  localStorage.setItem('ss-theme', b.dataset.themePref);
  applyTheme();
}));
themeMedia.addEventListener('change', applyTheme);
applyTheme();

// a take lives only in browser memory until Stop — closing the tab mid-take destroys it
window.addEventListener('beforeunload', (e) => {
  if (state.recording || state.busy) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- countdown preference (persisted) ----------
const cdSel = $('sel-countdown');
cdSel.value = localStorage.getItem('ss-countdown') ?? '3';
cdSel.addEventListener('change', () => localStorage.setItem('ss-countdown', cdSel.value));

// Recording quality — Mbps for every mode; '' = Auto (raw screen 8 / composite 12 / camera 12).
const brSel = $('sel-bitrate');
brSel.value = localStorage.getItem('ss-bitrate') ?? '';
brSel.addEventListener('change', () => localStorage.setItem('ss-bitrate', brSel.value));

// ---------- restore last-session settings (ratio, auto-finish, mode) ----------
const savedRatio = localStorage.getItem('ss-ratio');
if (savedRatio && [...els.ratio.options].some((o) => o.value === savedRatio)) els.ratio.value = savedRatio;
for (const id of ['chk-autofinish', 'chk-autofinish-comp']) {
  const box = $(id);
  const saved = localStorage.getItem(`ss-${id}`);
  if (saved !== null) box.checked = saved === 'on';
  box.addEventListener('change', () => localStorage.setItem(`ss-${id}`, box.checked ? 'on' : 'off'));
}

// ---------- boot ----------
installGlobalHandlers(); // capture uncaught errors + visibility changes from the very start
updateRatioLabel();
refreshHealth();
refreshDisk();
setInterval(refreshDisk, 30000);
renderTakes();
const savedMode = localStorage.getItem('ss-mode');
setMode(savedMode && modes[savedMode] ? savedMode : 'camera');
