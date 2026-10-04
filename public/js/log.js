// log.js — client error + event logging for Segan Sessions.
// Motivation: the record pipeline used to swallow failures in silent `catch {}` /
// `.catch(()=>{})` blocks, so a freeze left NO trace and every debug was guesswork.
// Now every error and key lifecycle event is (1) printed to the console and (2) shipped
// to the server (POST /api/log → <data>/segan-session.log) so a future freeze leaves
// a readable trail on disk. Fire-and-forget: logging must never throw into the caller.

const RING = [];          // in-memory tail, handy from the console (window.__seganLogs())
const MAX = 300;

function post(entry) {
  try {
    // keepalive so a log emitted just before the page is hidden/occluded still lands —
    // that's exactly the moment the freeze happens.
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

// only keep JSON-serializable fields so one weird value can't break the whole log line
function serial(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    try { JSON.stringify(v); out[k] = v; } catch { out[k] = String(v); }
  }
  return out;
}

function record(level, context, extra) {
  const entry = { t: new Date().toISOString(), level, context, ...serial(extra) };
  RING.push(entry);
  if (RING.length > MAX) RING.shift();
  post(entry);
  return entry;
}

export function logEvent(context, data = {}) {
  console.log(`[segan] ${context}`, data);
  return record('info', context, data);
}

export function logError(context, err, data = {}) {
  const e = err instanceof Error
    ? { name: err.name, message: err.message, stack: err.stack }
    : { message: String(err) };
  console.error(`[segan] ${context}:`, err, data);
  return record('error', context, { err: e, ...data });
}

export function recentLogs() { return RING.slice(); }

// Global safety net: nothing uncaught should ever vanish again. Also logs visibility
// changes — the single most useful signal for the "recording froze while hidden" class of bug.
let installed = false;
export function installGlobalHandlers() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) =>
    logError('window.onerror', e.error || e.message, { filename: e.filename, line: e.lineno, col: e.colno }));
  window.addEventListener('unhandledrejection', (e) => logError('unhandledrejection', e.reason));
  document.addEventListener('visibilitychange', () =>
    logEvent('visibilitychange', { state: document.visibilityState }));
  window.__seganLogs = recentLogs; // console helper
  logEvent('session-start', { ua: navigator.userAgent });
}
