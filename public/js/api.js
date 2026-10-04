// api.js — thin fetch helpers for the studio server.
async function j(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const getHealth = () => fetch('/api/health').then(j);
export const getDisk = () => fetch('/api/disk').then(j);
export const getManifest = () => fetch('/api/manifest').then(j);
export const getScripts = () => fetch('/api/scripts').then(j);
export const getScript = (slug) => fetch(`/api/scripts/${encodeURIComponent(slug)}`).then((r) => {
  if (!r.ok) throw new Error('script not found');
  return r.text();
});

export function uploadRecording(blob, meta) {
  const q = encodeURIComponent(JSON.stringify(meta));
  return fetch(`/api/recordings?meta=${q}`, { method: 'POST', body: blob }).then(j);
}

// streaming record (OBS-style): chunks go straight to disk, nothing buffers in RAM
export const recStart = (meta) =>
  fetch(`/api/rec/start?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'POST' }).then(j);
export const recChunk = (id, blob) =>
  fetch(`/api/rec/chunk?id=${encodeURIComponent(id)}`, { method: 'POST', body: blob }).then(j);
export const recFinish = (id) => fetch(`/api/rec/finish?id=${encodeURIComponent(id)}`, { method: 'POST' }).then(j);
export const recAbort = (id) => fetch(`/api/rec/abort?id=${encodeURIComponent(id)}`, { method: 'POST' }).then(j);
// "still recording" heartbeat — a paused take sends no chunks, and silence is how a crash looks
export const recPing = (id) => fetch(`/api/rec/ping?id=${encodeURIComponent(id)}`, { method: 'POST' }).then(j);
export const recRecover = () => fetch('/api/rec/recover', { method: 'POST' }).then(j);

export const finishTake = (id, ratio) =>
  fetch(`/api/takes/${id}/finish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ratio ? { ratio } : {}),
  }).then(j);

export const patchTake = (id, patch) =>
  fetch(`/api/takes/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }).then(j);

export const deleteTake = (id) => fetch(`/api/takes/${id}`, { method: 'DELETE' }).then(j);
export const clearTakes = () => fetch('/api/takes', { method: 'DELETE' }).then(j);
export const revealTake = (id) =>
  fetch(`/api/reveal${id ? `?id=${encodeURIComponent(id)}` : ''}`, { method: 'POST' }).then(j);
// Open a whole folder by name ('images' | 'assets'). The server whitelists the name.
export const revealDir = (dir) =>
  fetch(`/api/reveal?dir=${encodeURIComponent(dir)}`, { method: 'POST' }).then(j);

export const phoneStatus = () => fetch('/api/phone/status').then(j);
export const phoneCameras = () => fetch('/api/phone/cameras').then(j);
export const phoneRecordStart = (opts) =>
  fetch('/api/phone/record/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts),
  }).then(j);
export const phoneRecordStop = () => fetch('/api/phone/record/stop', { method: 'POST' }).then(j);
export const phoneRecordStatus = () => fetch('/api/phone/record/status').then(j);
export const phonePullLatest = () => fetch('/api/phone/pull-latest', { method: 'POST' }).then(j);
export const phoneMedia = () => fetch('/api/phone/media').then(j);
export const phonePull = (items, reel) =>
  fetch('/api/phone/pull', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, reel }),
  }).then(j);
export const phonePullProgress = () => fetch('/api/phone/pull/progress').then(j);
export const phoneMirrorStart = () => fetch('/api/phone/mirror/start', { method: 'POST' }).then(j);
export const phoneMirrorStop = () => fetch('/api/phone/mirror/stop', { method: 'POST' }).then(j);
export const phoneMirrorStatus = () => fetch('/api/phone/mirror/status').then(j);
export const phoneWirelessConnect = () => fetch('/api/phone/wireless/connect', { method: 'POST' }).then(j);
export const phoneWirelessDisconnect = () => fetch('/api/phone/wireless/disconnect', { method: 'POST' }).then(j);
export const phoneWirelessStatus = () => fetch('/api/phone/wireless/status').then(j);

export const screenerBackdropSave = (file) =>
  fetch('/api/screener/backdrop', {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  }).then(j);
export const screenerBackdropClear = () => fetch('/api/screener/backdrop', { method: 'DELETE' }).then(j);
