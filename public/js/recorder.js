// recorder.js — MediaRecorder wrappers + device helpers.
// Chrome ≥126 on macOS records real H.264/AAC MP4; if the H.264 encoder fails to
// initialize (profile/size quirks), we transparently fall back to the next codec —
// a take must never be lost to encoder init. videoBitsPerSecond MUST be set:
// Chrome's default is 2.5 Mbps regardless of resolution.
//
// Two recorders live here:
//   • Recorder          — buffers in RAM, saves one Blob on Stop (short reels; known-good).
//   • StreamingRecorder — streams 1s chunks straight to disk (OBS-style; multi-hour, crash-safe).
import { recStart, recChunk, recFinish, recAbort, recPing } from './api.js';
import { logError, logEvent } from './log.js';

const MIME_PREFERENCE = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm',
  '',
];

export class Recorder {
  constructor(stream, { bitrate = 12_000_000 } = {}) {
    this.stream = stream;
    this.bitrate = bitrate;
    this.mimes = MIME_PREFERENCE.filter((m) => m === '' || MediaRecorder.isTypeSupported(m));
    this.mimeIdx = 0;
    this.chunks = [];
    this.error = null;
    this.streaming = false;
    this.gen = 0; // see StreamingRecorder._build — a replaced recorder's late events are ignored
    this._build();
  }

  get mime() { return this.mimes[this.mimeIdx]; }

  _build() {
    const gen = ++this.gen;
    this.rec = new MediaRecorder(this.stream, {
      mimeType: this.mime || undefined,
      videoBitsPerSecond: this.bitrate,
      audioBitsPerSecond: 128_000,
    });
    this.rec.ondataavailable = (e) => { if (gen === this.gen && e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.onerror = (e) => {
      if (gen !== this.gen) return;
      const err = e.error || new Error('recorder error');
      logError('MediaRecorder.onerror(buffered)', err, { mime: this.mime });
      // Nothing captured yet + another codec available → rebuild and keep rolling.
      if (this.chunks.length === 0 && this.mimeIdx < this.mimes.length - 1) {
        console.warn(`Recorder: ${this.mime || 'default'} failed (${err.message}) — falling back`);
        try { this.rec.stop(); } catch {}
        this.mimeIdx += 1;
        this._build();
        this.rec.start(1000);
      } else {
        this.error = err;
      }
    };
  }

  start() {
    this.chunks = [];
    this.error = null;
    this.rec.start(1000); // 1s timeslice: bounded chunks, resilient to long takes
    this.startedAt = Date.now();
  }

  pause() { if (this.rec.state === 'recording') this.rec.pause(); }
  resume() { if (this.rec.state === 'paused') this.rec.resume(); }

  stop() {
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (this.error && !this.chunks.length) return reject(this.error);
        if (!this.chunks.length) return reject(new Error('recorder produced no data'));
        const type = (this.mime.split(';')[0]) || 'video/webm';
        resolve(new Blob(this.chunks, { type }));
      };
      const rec = this.rec; // the (possibly rebuilt) active recorder
      if (rec.state === 'inactive') return finish();
      const safety = setTimeout(finish, 8000); // never hang the UI on a missing onstop
      rec.onstop = () => { clearTimeout(safety); finish(); };
      rec.stop();
    });
  }
}

// StreamingRecorder — each ~1s MediaRecorder chunk is uploaded and appended to a file on
// the server AS IT ARRIVES, so nothing accumulates in browser RAM. This is what makes
// multi-hour recordings possible and keeps footage on disk if the tab crashes.
//
// The 0-byte bug this replaces: the earlier streaming rewrite dropped the codec fallback,
// so an H.264 encoder-init failure recorded silence. Here, if MediaRecorder errors BEFORE
// the first chunk lands, we abort the empty session, advance the codec, and restart. Once
// a chunk has landed the codec is committed (no mid-stream switching).
export class StreamingRecorder {
  constructor(stream, { bitrate = 12_000_000, meta = {} } = {}) {
    this.stream = stream;
    this.bitrate = bitrate;
    this.meta = meta;
    this.mimes = MIME_PREFERENCE.filter((m) => m === '' || MediaRecorder.isTypeSupported(m));
    this.mimeIdx = 0;
    this.queue = [];          // chunks awaiting upload — drained continuously so RAM stays flat
    this.sessionId = null;
    this.sent = 0;
    this.firstChunkLanded = false;
    this.error = null;
    this._draining = null;
    this.startedAt = null;
    this.streaming = true;
    this.gen = 0; // which MediaRecorder is current — events from a replaced one are ignored
  }

  get mime() { return this.mimes[this.mimeIdx]; }
  get mimeType() { return this.rec?.mimeType || this.mime; }

  _build() {
    // Each recorder only ever speaks for its own generation. A recorder replaced by a codec
    // fallback still fires events: Chrome flushes its last bytes AFTER stop(), and when the codec
    // failed late those bytes are the dead codec's header. Glued onto the new take they break the
    // video and drop the audio — a real 4-min take on 2026-09-12 came out with 19,915 decode
    // errors and no audio track. Reproduced by test/screener-audio.mjs ("late codec failure").
    const gen = ++this.gen;
    this.rec = new MediaRecorder(this.stream, {
      mimeType: this.mime || undefined,
      videoBitsPerSecond: this.bitrate,
      audioBitsPerSecond: 128_000,
    });
    this.rec.ondataavailable = (e) => {
      if (gen !== this.gen) return; // a retired recorder's flush — never part of this take
      if (e.data && e.data.size) { this.queue.push(e.data); this._drain(); }
    };
    this.rec.onerror = (e) => {
      if (gen !== this.gen) return;
      const err = e.error || new Error('recorder error');
      logError('MediaRecorder.onerror', err, { mime: this.mime, firstChunkLanded: this.firstChunkLanded });
      this._onError(err);
    };
  }

  async _onError(err) {
    // Encoder/init failure before any data landed → switch codec + restart cleanly.
    if (!this.firstChunkLanded && this.mimeIdx < this.mimes.length - 1) {
      logEvent('StreamingRecorder.codecFallback', { from: this.mime || 'default', reason: err.message });
      this.gen++; // retire the failed recorder BEFORE stop(): the flush stop() triggers must be ignored
      try { this.rec.stop(); } catch {}
      const dead = this.sessionId;
      this.sessionId = null;
      this.queue = [];
      if (dead) { try { await recAbort(dead); } catch {} }
      this.mimeIdx += 1;
      await this._openSession();
    } else {
      this.error = err;
    }
  }

  async _openSession() {
    this._build();
    const { id, pingMs } = await recStart({ ...this.meta, mime: this.mime });
    this.sessionId = id;
    // Heartbeat so the server can tell "paused" (alive, no chunks) from "the browser died" (silent),
    // and finalize a crashed take on its own. The server sets the pace (a quarter of its timeout).
    clearInterval(this._keepalive);
    this._healthAt = 0;
    this._keepalive = setInterval(() => {
      const sid = this.sessionId;
      if (sid) recPing(sid).catch((e) => logError('rec.ping', e, { sid }));
      // ~Once a minute, a memory/backlog trail in segan-session.log. A tab killed for memory logs
      // nothing itself — this way the growth before it is on record.
      const now = Date.now();
      if (now - this._healthAt >= 60_000) {
        this._healthAt = now;
        logEvent('rec-health', {
          sec: this.startedAt ? Math.round((now - this.startedAt) / 1000) : 0,
          sent: this.sent, queued: this.queue.length,
          queuedMB: +(this.queue.reduce((a, b) => a + b.size, 0) / 1e6).toFixed(1),
          heapMB: Math.round((performance.memory?.usedJSHeapSize || 0) / 1e6),
        });
      }
    }, pingMs || 30_000);
    try {
      this.rec.start(1000); // 1s chunks streamed straight to disk (never held in RAM)
    } catch (err) {
      await this._onError(err); // a synchronous start failure is a pre-first-chunk error
    }
  }

  // upload queued chunks one at a time, in order (localhost is fast, so the queue stays near-empty)
  _drain() {
    if (this._draining || !this.sessionId) return this._draining || Promise.resolve();
    this._draining = (async () => {
      while (this.queue.length && !this.error) {
        const sid = this.sessionId;
        if (!sid) break;                    // a codec fallback is swapping the session out
        try {
          await recChunk(sid, this.queue[0]);
          if (this.sessionId !== sid) break; // session changed mid-flight → abandon this drain
          this.queue.shift();
          this.sent++;
          this.firstChunkLanded = true;
        } catch (err) { this.error = err; break; }
      }
      this._draining = null;
    })();
    return this._draining;
  }

  async start() {
    this.queue = [];
    this.error = null;
    this.firstChunkLanded = false;
    this.mimeIdx = 0;
    await this._openSession();
    this.startedAt = Date.now();
  }

  pause() { if (this.rec?.state === 'recording') this.rec.pause(); }
  resume() { if (this.rec?.state === 'paused') this.rec.resume(); }

  // stop → flush remaining chunks → server finalizes (remux + probe + manifest) → returns the take
  async stop() {
    if (this.rec && this.rec.state !== 'inactive') {
      await new Promise((resolve) => {
        const safety = setTimeout(resolve, 8000); // never hang the UI on a missing onstop
        this.rec.onstop = () => { clearTimeout(safety); resolve(); };
        try { this.rec.stop(); } catch { resolve(); }
      });
    }
    await this._flush().catch(() => {}); // best-effort: finalize whatever reached disk
    clearInterval(this._keepalive);
    if (!this.sessionId) throw (this.error || new Error('recording never started'));
    if (this.error && !this.firstChunkLanded) throw this.error;
    return recFinish(this.sessionId);
  }

  async _flush() {
    await this._drain();
    while (this.queue.length && !this.error) await this._drain();
    if (this.queue.length) throw this.error || new Error('some chunks did not upload');
  }

  // discard the take entirely (retake / cancel) — deletes the .part file on the server
  async abort() {
    clearInterval(this._keepalive);
    if (this.rec && this.rec.state !== 'inactive') { try { this.rec.stop(); } catch {} }
    this.queue = [];
    if (this.sessionId) { try { await recAbort(this.sessionId); } catch {} this.sessionId = null; }
  }
}

// Pick the recorder: streaming-to-disk by default (replaces OBS). Set localStorage
// 'ss-buffered' = 'on' to force the known-good buffered path as a fallback.
export function makeRecorder(stream, { bitrate = 12_000_000, meta = {} } = {}) {
  let forceBuffered = false;
  try { forceBuffered = localStorage.getItem('ss-buffered') === 'on'; } catch {}
  return forceBuffered ? new Recorder(stream, { bitrate }) : new StreamingRecorder(stream, { bitrate, meta });
}

// ---- device helpers (shared by camera + composite modes) ----

export async function ensurePermission() {
  // One throwaway getUserMedia so enumerateDevices returns labels.
  const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  s.getTracks().forEach((t) => t.stop());
}

export async function listDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return {
    cams: devs.filter((d) => d.kind === 'videoinput'),
    mics: devs.filter((d) => d.kind === 'audioinput'),
  };
}

const cameraConstraints = (camId) => ({
  deviceId: camId ? { exact: camId } : undefined,
  width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
});

// Camera mode: one stream, camera + mic together.
export function openCamera(camId, micId) {
  return navigator.mediaDevices.getUserMedia({
    video: cameraConstraints(camId),
    audio: micId ? { deviceId: { exact: micId } } : true,
  });
}

// Screener opens the bubble camera and the mic SEPARATELY. When the mic rode on the camera
// stream, a window/phone bubble silently dropped your voice, and the camera could never turn
// off without taking the mic with it (found 2026-09-25).
export function openCameraVideo(camId) {
  return navigator.mediaDevices.getUserMedia({ video: cameraConstraints(camId), audio: false });
}
export function openMic(micId) {
  return navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true, video: false });
}

// Fill a device <select>, keeping the current (or saved) choice when that device still exists.
export function fillDeviceSelect(sel, list, kind, savedKey) {
  const prev = sel.value || localStorage.getItem(savedKey) || '';
  sel.innerHTML = '';
  list.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `${kind} ${i + 1}`;
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}
