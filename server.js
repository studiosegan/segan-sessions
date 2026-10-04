#!/usr/bin/env node
// Segan Sessions server — zero-dependency node:http. Static UI + capture API.
// Binds 127.0.0.1 only (localhost = secure context for camera APIs; nothing on the LAN).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as manifest from './lib/manifest.js';
import * as ff from './lib/ffmpeg.js';
import * as phone from './lib/phone.js';
import {
  nowStamp, isoNow, makeId, safeSlug, readJsonBody, streamToFile,
  run, which, diskFreeGB, ensureDir, libRelative,
} from './lib/util.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
// Everything the installer owns: the app, its private runtime (node, ffmpeg, scrcpy, adb) and data/.
const SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Segan Sessions');
// The installer's tools come first, so the app runs on the versions it was tested with and never
// needs Homebrew. A git checkout without an install falls back to whatever is on PATH.
for (const dir of [path.join(SUPPORT_DIR, 'runtime', 'scrcpy'), path.join(SUPPORT_DIR, 'runtime', 'bin')]) {
  if (fs.existsSync(dir)) process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
}
// Your footage: one Finder-friendly folder, ~/Movies/Segan Sessions. An optional config.json next to
// the app's data moves it — the whole library, any single folder, or the takes list — to an external
// drive or into a project's own layout (README → "Save recordings somewhere else"). SEGAN_LIBRARY
// beats the config and means the default layout in that folder: the self-tests point it (and
// SEGAN_DATA) at a throwaway dir, so a test run never touches real takes whatever the config says.
const expandPath = (p, base) => path.resolve(base, String(p).replace(/^~(?=$|\/)/, os.homedir()));
function loadConfig() {
  if (process.env.SEGAN_LIBRARY) return {};
  const file = process.env.SEGAN_CONFIG || path.join(SUPPORT_DIR, 'config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; }
  catch (e) {
    if (e.code !== 'ENOENT') console.error(`Ignoring ${file} (${e.message}) — recording to the default folders.`);
    return {};
  }
}
const config = loadConfig();
const LIBRARY = expandPath(process.env.SEGAN_LIBRARY || config.library || '~/Movies/Segan Sessions', os.homedir());
const folder = (key, name) => expandPath(config.folders?.[key] || name, LIBRARY);
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// Small app state that isn't footage: the Screener backdrop, phone thumbnails, the session log.
const DATA_DIR = path.resolve(process.env.SEGAN_DATA || path.join(SUPPORT_DIR, 'data'));
const DIRS = {
  camera: folder('camera', 'Camera'),
  screen: folder('screen', 'Screen'),
  phone: folder('phone', 'Phone'),
  // Photos pulled from the phone. Deliberately NOT in ASSET_DIRS/the takes manifest: the manifest is
  // video metadata (resolution/fps/duration), so a still would show up broken in Takes. Because they
  // never get a Takes row, the "🖼 Images" button in the Takes header is the only way in.
  images: folder('images', 'Images'),
  scripts: folder('scripts', 'Scripts'),
};
// The takes list. Take paths inside it are relative to LIBRARY. "Open folder" opens the folder it
// sits in — the library itself by default.
const TAKES_FILE = expandPath(config.takes || 'takes.json', LIBRARY);
const FOOTAGE_HOME = path.dirname(TAKES_FILE);
const ASSET_DIRS = {
  camera: DIRS.camera,
  screen: DIRS.screen,
  'phone-camera': DIRS.phone,
  'phone-screen': DIRS.phone,
  'phone-pull': DIRS.phone,
};
// First run only: a sample teleprompter script, so the prompter isn't empty before you write one.
const firstRun = !fs.existsSync(DIRS.scripts);
Object.values(DIRS).forEach(ensureDir);
if (firstRun) {
  const samples = path.join(APP_DIR, 'samples', 'Scripts');
  try { for (const f of fs.readdirSync(samples)) fs.copyFileSync(path.join(samples, f), path.join(DIRS.scripts, f)); } catch {}
}
// Phone thumbnails, cached by path+mtime+size so the grid only pays for each file once.
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
ensureDir(DATA_DIR); // holds the Screener backdrop + the error log (segan-session.log)
ensureDir(THUMB_DIR);
ensureDir(FOOTAGE_HOME);
manifest.init(TAKES_FILE);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
const fail = (res, status, message) => json(res, status, { error: message });

// Append one JSON line to the on-disk error log. Best-effort — logging must never crash a request.
const LOG_FILE = path.join(DATA_DIR, 'segan-session.log');
function logToFile(entry) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify({ t: isoNow(), ...entry }) + '\n'); } catch {}
}

// ---------- static ----------
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return fail(res, 404, 'not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- video streaming with Range support (so <video> can seek) ----------
function serveVideo(req, res, file) {
  if (!fs.existsSync(file)) return fail(res, 404, 'file missing on disk');
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file)] || 'video/mp4';
  const range = req.headers.range;
  if (range) {
    // validate BEFORE writeHead — a bad range must never take the process down
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    let start, end;
    if (m && !m[1] && m[2]) { // suffix range: last N bytes
      const n = Math.min(Number(m[2]), size);
      start = size - n; end = size - 1;
    } else if (m && m[1]) {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1, 'Content-Type': type,
    });
    stream.pipe(res);
  } else {
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
    stream.pipe(res);
  }
}

// ---------- recordings ingest ----------
async function ingestRecording(req, res, url) {
  let meta = {};
  try { meta = JSON.parse(url.searchParams.get('meta') || '{}'); }
  catch { return fail(res, 400, 'bad meta JSON'); }
  const mode = ASSET_DIRS[meta.mode] ? meta.mode : 'camera';
  const ratio = ff.RATIOS[meta.ratio] ? meta.ratio : '9:16';
  const ext = (meta.mime || '').includes('mp4') ? '.mp4' : '.webm';
  const stamp = nowStamp();
  const id = makeId(stamp); // id in the filename too — two same-second saves must never collide
  const reel = meta.reel ? `-${safeSlug(meta.reel)}` : '';
  const base = `${id}-${mode}-${ratio.replace(':', 'x')}${reel}`;
  const dir = ASSET_DIRS[mode];
  const file = path.join(dir, base + ext);

  try { await streamToFile(req, file); }
  catch (e) { return fail(res, 500, `save failed: ${e.message}`); }

  let probed = {}, status = 'raw', note = meta.notes || '';
  try { probed = await ff.probe(file); }
  catch (e) { status = 'error'; note = `${note} [probe failed: ${e.message}]`.trim(); }

  const take = {
    id,
    file: libRelative(LIBRARY, file),
    mode, ratio,
    resolution: probed.width ? `${probed.width}x${probed.height}` : null,
    fps: probed.fps ?? null,
    duration: probed.duration ?? null,
    size_bytes: probed.size_bytes ?? null,
    codec: probed.codec ?? null,
    container: probed.container ?? null,
    created: isoNow(),
    device: meta.device || null,
    reel: meta.reel || null,
    notes: note,
    status,
    finished_file: null,
  };
  await manifest.append(take);
  json(res, 201, take);
}

// ---------- streaming recordings (OBS-style) ----------
// Chunks are appended to a <file>.part on disk AS THEY ARRIVE, so nothing accumulates in browser
// RAM — multi-hour recordings are possible, and a browser crash leaves the footage on disk.
// Recording is blocked under this many GB free (tunable for tests via SEGAN_MIN_FREE_GB).
const MIN_FREE_GB = Number(process.env.SEGAN_MIN_FREE_GB) || 2;
const recSessions = new Map(); // id -> { ws, partFile, finalFile, ext, meta, mode, ratio, bytes, lastSeen }
// A session silent this long (no chunk, no ping) belongs to a browser that died mid-recording, and
// is finalized into a take WITHOUT a server restart — otherwise a tab that ran out of memory an hour
// into a meeting leaves its footage invisible as a .part until the next restart. Real chunks arrive
// every ~3.7 s, at most ~12 s apart (one per keyframe), and the page pings every ORPHAN_MS/4 even
// while paused — so 2 min is 10× the worst real gap.
const ORPHAN_MS = Number(process.env.SEGAN_ORPHAN_MS) || 120_000;

async function recStart(req, res, url) {
  let meta = {};
  try { meta = JSON.parse(url.searchParams.get('meta') || '{}'); }
  catch { return fail(res, 400, 'bad meta JSON'); }
  const mode = ASSET_DIRS[meta.mode] ? meta.mode : 'camera';
  // the drive this take is going to — with config.json a folder can live on another disk
  if ((await diskFreeGB(ASSET_DIRS[mode])) < MIN_FREE_GB) {
    return fail(res, 507, `less than ${MIN_FREE_GB} GB free — free up disk space before recording`);
  }
  const ratio = ff.RATIOS[meta.ratio] ? meta.ratio : '9:16';
  const ext = (meta.mime || '').includes('mp4') ? '.mp4' : '.webm';
  const id = makeId(nowStamp());
  const reel = meta.reel ? `-${safeSlug(meta.reel)}` : '';
  const finalFile = path.join(ASSET_DIRS[mode], `${id}-${mode}-${ratio.replace(':', 'x')}${reel}${ext}`);
  const partFile = `${finalFile}.part`;
  const ws = fs.createWriteStream(partFile);
  ws.on('error', () => {}); // a disk write error must not crash the server mid-record
  recSessions.set(id, { ws, partFile, finalFile, ext, meta, mode, ratio, bytes: 0, lastSeen: Date.now() });
  json(res, 200, { id, pingMs: Math.round(ORPHAN_MS / 4) });
}

function recChunk(req, res, url) {
  const s = recSessions.get(url.searchParams.get('id'));
  if (!s) return fail(res, 404, 'no such recording session');
  s.lastSeen = Date.now();
  const bufs = [];
  req.on('data', (d) => bufs.push(d));
  req.on('error', () => { try { res.writeHead(500); res.end(); } catch {} });
  req.on('end', () => {
    const buf = Buffer.concat(bufs);
    s.bytes += buf.length;
    s.ws.write(buf, () => json(res, 200, { ok: true, bytes: s.bytes })); // ack after the write lands
  });
}

async function recFinish(req, res, url) {
  const id = url.searchParams.get('id');
  const s = recSessions.get(id);
  if (!s) return fail(res, 404, 'no such recording session');
  recSessions.delete(id);
  await new Promise((resolve) => s.ws.end(resolve)); // flush + close the .part file
  try {
    const take = await finalizePart({ id, partFile: s.partFile, finalFile: s.finalFile, ext: s.ext, mode: s.mode, ratio: s.ratio, meta: s.meta });
    json(res, 201, take);
  } catch (e) { fail(res, 500, e.message); }
}

// Turn a completed/orphaned .part into a final file + manifest entry. Shared by recFinish
// and crash recovery. Throws only if the file can't be finalized at all.
async function finalizePart({ id, partFile, finalFile, ext, mode, ratio, meta = {} }) {
  let note = meta.notes || '', ok = false;
  if (ext === '.mp4') {
    // remux to a clean faststart MP4 (moov at the front) so it seeks/previews instantly
    try { await ff.remuxToMp4(partFile, finalFile, { audio: 'aac' }); try { fs.unlinkSync(partFile); } catch {} ok = true; }
    catch (e) { try { fs.renameSync(partFile, finalFile); ok = true; note = `${note} [remux skipped: ${e.message}]`.trim(); } catch {} }
  } else {
    try { fs.renameSync(partFile, finalFile); ok = true; } catch {}
  }
  if (!ok) throw new Error('could not finalize the recording file');

  let probed = {}, status = 'raw';
  try { probed = await ff.probe(finalFile); }
  catch (e) { status = 'error'; note = `${note} [probe failed: ${e.message}]`.trim(); }
  const take = {
    id, file: libRelative(LIBRARY, finalFile), mode, ratio,
    resolution: probed.width ? `${probed.width}x${probed.height}` : null,
    fps: probed.fps ?? null, duration: probed.duration ?? null,
    size_bytes: probed.size_bytes ?? null, codec: probed.codec ?? null, container: probed.container ?? null,
    created: isoNow(), device: meta.device || null, reel: meta.reel || null,
    notes: note, status, finished_file: null,
  };
  await manifest.append(take);
  return take;
}

// Recover recordings interrupted by a crash: any <file>.part not owned by a live session is
// finalized into a take. Runs on boot and on demand (POST /api/rec/recover). Worst case the
// footage loses the last ~1s (an un-acked chunk); it is never lost entirely.
async function recoverOrphans() {
  const live = new Set([...recSessions.values()].map((s) => s.partFile));
  const recovered = [];
  for (const [mode, dirp] of [['camera', ASSET_DIRS.camera], ['screen', ASSET_DIRS.screen]]) {
    let files = [];
    try { files = fs.readdirSync(dirp).filter((f) => f.endsWith('.part')); } catch { continue; }
    for (const f of files) {
      const partFile = path.join(dirp, f);
      if (live.has(partFile)) continue; // owned by an active recording
      let size = 0; try { size = fs.statSync(partFile).size; } catch {}
      if (size < 1000) { try { fs.unlinkSync(partFile); } catch {} continue; } // empty crash stub
      const finalFile = partFile.slice(0, -'.part'.length);
      const ext = path.extname(finalFile);
      const ratio = ((finalFile.match(/-(\d+x\d+)/) || [])[1] || '').replace('x', ':') || '9:16';
      try {
        recovered.push(await finalizePart({ id: makeId(nowStamp()), partFile, finalFile, ext, mode, ratio, meta: { notes: '[recovered from crash]' } }));
      } catch (e) { console.error('recover failed:', f, e.message); }
    }
  }
  return recovered;
}

// The page's "still recording" heartbeat — keeps a paused take (no chunks) from looking orphaned.
function recPing(req, res, url) {
  const s = recSessions.get(url.searchParams.get('id'));
  if (!s) return fail(res, 404, 'no such recording session');
  s.lastSeen = Date.now();
  json(res, 200, { ok: true });
}

// Finalize sessions whose browser went silent — the take appears in Takes on its own.
let lastWatch = Date.now();
async function watchOrphans() {
  const now = Date.now();
  // A long gap since the last tick means the Mac slept: this timer and the page were BOTH frozen.
  // Don't mistake that sleep for a crash — give every session a fresh start and check next time.
  if (now - lastWatch > SLEEP_GAP_MS) {
    for (const s of recSessions.values()) s.lastSeen = now;
  }
  lastWatch = now;
  for (const [id, s] of recSessions) {
    if (now - s.lastSeen < ORPHAN_MS) continue;
    recSessions.delete(id);
    await new Promise((resolve) => s.ws.end(resolve)); // flush + close the .part
    if (s.bytes < 1000) { try { fs.unlinkSync(s.partFile); } catch {} continue; } // never recorded anything
    try {
      const take = await finalizePart({ id, partFile: s.partFile, finalFile: s.finalFile, ext: s.ext, mode: s.mode, ratio: s.ratio,
        meta: { ...s.meta, notes: '[recovered from crash]' } });
      console.log(`Recovered an interrupted recording (browser went silent ${Math.round((now - s.lastSeen) / 1000)}s): ${take.file}`);
    } catch (e) { console.error('orphan finalize failed:', id, e.message); }
  }
}
const WATCH_MS = Math.max(1000, Math.min(15_000, Math.round(ORPHAN_MS / 4)));
// Must stay below ORPHAN_MS minus a ping interval, or a sleep could finalize a live take before the
// grace kicks in (production: 45 s vs 120 − 30 = 90 s).
const SLEEP_GAP_MS = Math.min(ORPHAN_MS / 2, Math.max(3 * WATCH_MS, 30_000));
setInterval(() => { watchOrphans().catch((e) => console.error('orphan watch failed:', e.message)); }, WATCH_MS).unref();

function recAbort(req, res, url) {
  const id = url.searchParams.get('id');
  const s = recSessions.get(id);
  if (s) { recSessions.delete(id); try { s.ws.end(); } catch {} try { fs.unlinkSync(s.partFile); } catch {} }
  json(res, 200, { ok: true });
}

async function finishTake(req, res, id) {
  const take = manifest.get(id);
  if (!take) return fail(res, 404, 'unknown take');
  const body = await readJsonBody(req).catch(() => ({}));
  const ratio = ff.RATIOS[body.ratio] ? body.ratio : (ff.RATIOS[take.ratio] ? take.ratio : '9:16');
  const inFile = path.join(LIBRARY, take.file);
  if (!fs.existsSync(inFile)) return fail(res, 410, 'raw file missing on disk');
  const outFile = inFile.replace(/\.(mp4|webm|mkv)$/i, '') + '-fin.mp4';
  try {
    const { noop, probe: probed } = await ff.finish(inFile, outFile, ratio);
    const updated = await manifest.update(id, {
      status: 'finished',
      // no-op → the raw already IS the deliverable; point at it instead of duplicating the file
      finished_file: noop ? take.file : libRelative(LIBRARY, outFile),
      finished_resolution: `${probed.width}x${probed.height}`,
    });
    json(res, 200, updated);
  } catch (e) {
    await manifest.update(id, { status: 'error', notes: `${take.notes || ''} [finish failed]`.trim() });
    fail(res, 500, e.message);
  }
}

// ---------- teleprompter scripts ----------
// Any .md or .txt in <library>/Scripts, or one folder down (a folder per series reads well).
// `file` is relative to the Scripts folder; the list doubles as the whitelist for reading one.
const SCRIPT_RE = /\.(md|txt)$/i;
function listScripts() {
  const out = [];
  const add = (rel, track = null) => out.push({ slug: rel.replace(SCRIPT_RE, ''), track, file: rel });
  let entries = [];
  try { entries = fs.readdirSync(DIRS.scripts, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isFile() && SCRIPT_RE.test(e.name)) add(e.name);
    else if (e.isDirectory()) {
      let sub = [];
      try { sub = fs.readdirSync(path.join(DIRS.scripts, e.name)); } catch {}
      for (const f of sub) if (!f.startsWith('.') && SCRIPT_RE.test(f)) add(`${e.name}/${f}`, e.name);
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------- phone ----------
async function phoneRecordStart(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const source = body.source === 'screen' ? 'screen' : 'camera';
  const stamp = nowStamp();
  const base = `${stamp}-phone-${source}`;
  const file = path.join(ASSET_DIRS['phone-camera'], base + '.mkv');
  try {
    const started = await phone.startRecord({
      source, cameraId: body.cameraId, facing: body.facing, size: body.size,
      fps: body.fps, codec: body.codec, bitrate: body.bitrate, file,
    });
    json(res, 200, { ok: true, file: libRelative(LIBRARY, file), meta: started.meta });
  } catch (e) { fail(res, 500, e.message); }
}

async function phoneRecordStop(req, res) {
  let stopped;
  try { stopped = await phone.stopRecord(); }
  catch (e) { return fail(res, 409, e.message); }

  const mode = stopped.meta.source === 'screen' ? 'phone-screen' : 'phone-camera';
  const stamp = nowStamp();
  const take = {
    id: makeId(stamp), file: libRelative(LIBRARY, stopped.file), mode,
    ratio: '9:16', resolution: null, fps: null, duration: null, size_bytes: null,
    codec: null, container: 'mkv', created: isoNow(),
    device: stopped.meta.size ? `phone ${stopped.meta.source} ${stopped.meta.size}` : `phone ${stopped.meta.source}`,
    reel: null, notes: '', status: 'error', finished_file: null,
  };

  if (!stopped.ok) {
    // nothing arrived from the phone — delete the empty file, don't clutter the manifest
    try { fs.unlinkSync(stopped.file); } catch {}
    return fail(res, 422,
      `No video arrived from the phone ${stopped.meta.source}. ` +
      (stopped.meta.source === 'camera'
        ? 'Direct camera streaming needs Android 12+ (and some brands block it) — use Screen mirror + the phone’s camera app, then “Pull latest”. '
        : '') +
      `scrcpy said: ${stopped.stderrTail.slice(-200)}`);
  }
  try {
    const mp4 = stopped.file.replace(/\.mkv$/, '.mp4');
    const probed = await ff.remuxToMp4(stopped.file, mp4);
    fs.unlinkSync(stopped.file);
    Object.assign(take, {
      file: libRelative(LIBRARY, mp4), status: 'raw', container: probed.container,
      resolution: probed.width ? `${probed.width}x${probed.height}` : null,
      fps: probed.fps, duration: probed.duration, size_bytes: probed.size_bytes, codec: probed.codec,
    });
  } catch (e) {
    take.notes = `kept .mkv — remux failed: ${e.message}`;
  }
  await manifest.append(take);
  json(res, 200, take);
}

// Adopt media that is on disk but missing from the manifest, so it shows up in Takes.
// This happens when a pull (or the server) is interrupted after the file lands but before the
// manifest append — the footage is fine, it is just invisible in the UI.
async function adoptOrphans(req, res) {
  const MEDIA = /\.(mp4|mov|mkv|webm|m4v)$/i;
  const known = new Set(manifest.load().takes.flatMap((t) => [t.file, t.finished_file].filter(Boolean)));
  const adopted = [];
  for (const [mode, dir] of [['camera', ASSET_DIRS.camera], ['screen', ASSET_DIRS.screen], ['phone-pull', ASSET_DIRS['phone-pull']]]) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!MEDIA.test(f) || f.endsWith('.part') || /-fin\.mp4$/i.test(f)) continue;
      const abs = path.join(dir, f);
      // never adopt empty stubs (a crashed scrcpy leaves 0-byte .mkv files) — they would just
      // clutter Takes with permanent `error` rows
      try { if (fs.statSync(abs).size < 1024) continue; } catch { continue; }
      const rel = libRelative(LIBRARY, abs);
      if (known.has(rel)) continue;
      let probed = {}, status = 'raw', note = 'adopted from disk (manifest entry was missing)';
      try { probed = await ff.probe(abs); }
      catch (e) { status = 'error'; note = `${note} [probe failed: ${e.message}]`; }
      const take = {
        id: makeId(nowStamp()), file: rel, mode,
        ratio: probed.height > probed.width ? '9:16' : '16:9',
        resolution: probed.width ? `${probed.width}x${probed.height}` : null,
        fps: probed.fps ?? null, duration: probed.duration ?? null,
        size_bytes: probed.size_bytes ?? null, codec: probed.codec ?? null,
        container: probed.container ?? null,
        created: (() => { try { return new Date(fs.statSync(abs).mtime).toISOString(); } catch { return isoNow(); } })(),
        device: mode === 'phone-pull' ? 'phone camera app' : null, reel: null,
        notes: note, status, finished_file: null,
      };
      await manifest.append(take);
      adopted.push({ file: rel, mode, duration: take.duration, resolution: take.resolution });
    }
  }
  json(res, 200, { adopted, count: adopted.length });
}

// One thumbnail for the picker grid, cached on disk. Photos stream whole; videos use the
// sparse head+tail trick in phone.makeThumb (a 4.8 GB clip costs ~7 MB to preview).
async function phoneThumb(req, res, url) {
  const remote = url.searchParams.get('path') || '';
  const size = Number(url.searchParams.get('size') || 0);
  const sig = url.searchParams.get('sig') || '';
  if (!remote.startsWith('/sdcard/') || remote.includes('..') || remote.includes("'")) {
    return fail(res, 400, 'bad path');
  }
  const key = crypto.createHash('sha1').update(`${remote}|${size}|${sig}`).digest('hex').slice(0, 20);
  const cached = path.join(THUMB_DIR, `${key}.jpg`);
  try {
    if (!fs.existsSync(cached)) await phone.makeThumb(remote, size, cached);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(cached).pipe(res);
  } catch (e) {
    fail(res, 404, e.message); // the grid falls back to a placeholder tile
  }
}

// Pull the files ticked in the picker, one at a time so a 5 GB clip can't stall the rest.
// Videos join the footage manifest (and the Takes list); photos just land in <library>/Images/.
// Never deletes anything from the phone.
// Live state for the picker's progress bar. adb pull writes the destination file
// progressively, so watching it grow is an accurate, dependency-free progress source.
let pullJob = { active: false };

async function phonePull(req, res) {
  if (pullJob.active) return fail(res, 409, 'a pull is already running');
  const body = await readJsonBody(req).catch(() => ({}));
  const raw = Array.isArray(body.items) ? body.items
    : (Array.isArray(body.paths) ? body.paths.map((p) => ({ path: p, size: 0 })) : []);
  const items = raw.filter((it) => it && typeof it.path === 'string'
    && it.path.startsWith('/sdcard/') && !it.path.includes('..') && !it.path.includes("'"));
  if (!items.length) return fail(res, 400, 'no files selected');
  const reel = body.reel ? safeSlug(body.reel) : null;

  pullJob = {
    active: true, startedAt: Date.now(), total: items.length, index: 0,
    name: '', fileBytes: 0, fileTotal: 0, doneBytes: 0,
    totalBytes: items.reduce((a, b) => a + (Number(b.size) || 0), 0),
    pulled: 0, failed: 0,
  };

  const results = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const remote = items[i].path;
      const size = Number(items[i].size) || 0;
      Object.assign(pullJob, { index: i, name: remote.split('/').pop(), fileTotal: size, fileBytes: 0 });
      let ticker = null;
      try {
        const kind = phone.mediaKind(remote);
        if (!kind) throw new Error('not a video or photo');
        const dir = kind === 'photo' ? DIRS.images : ASSET_DIRS['phone-pull'];
        const dest = await phone.pullOne(remote, dir, (d) => {
          ticker = setInterval(() => {
            try { pullJob.fileBytes = fs.statSync(d).size; } catch {}
          }, 300);
        });
        if (ticker) { clearInterval(ticker); ticker = null; }
        const file = libRelative(LIBRARY, dest);
        if (kind === 'photo') {
          results.push({ remote, file, kind, ok: true });
        } else {
          const probed = await ff.probe(dest).catch(() => ({}));
          const take = {
            id: makeId(nowStamp()), file, mode: 'phone-pull',
            ratio: probed.height > probed.width ? '9:16' : '16:9',
            resolution: probed.width ? `${probed.width}x${probed.height}` : null,
            fps: probed.fps ?? null, duration: probed.duration ?? null,
            size_bytes: probed.size_bytes ?? null, codec: probed.codec ?? null,
            container: probed.container ?? null, created: isoNow(),
            device: 'phone camera app', reel, notes: `pulled from ${remote}`,
            status: 'raw', finished_file: null,
          };
          await manifest.append(take);
          results.push({ remote, file, kind, ok: true, id: take.id });
        }
        pullJob.pulled++;
      } catch (e) {
        results.push({ remote, ok: false, error: e.message });
        pullJob.failed++;
      } finally {
        if (ticker) clearInterval(ticker);
        pullJob.doneBytes += size;
        pullJob.fileBytes = 0;
      }
    }
  } finally {
    pullJob.active = false;
    pullJob.finishedAt = Date.now();
  }
  json(res, 200, { results, pulled: pullJob.pulled, failed: pullJob.failed });
}

async function phonePullLatest(req, res) {
  try {
    const { remote, dest } = await phone.pullLatest(ASSET_DIRS['phone-pull']);
    const probed = await ff.probe(dest).catch(() => ({}));
    const stamp = nowStamp();
    const take = {
      id: makeId(stamp), file: libRelative(LIBRARY, dest), mode: 'phone-pull',
      ratio: probed.height > probed.width ? '9:16' : '16:9',
      resolution: probed.width ? `${probed.width}x${probed.height}` : null,
      fps: probed.fps ?? null, duration: probed.duration ?? null,
      size_bytes: probed.size_bytes ?? null, codec: probed.codec ?? null,
      container: probed.container ?? null, created: isoNow(),
      device: 'phone camera app', reel: null, notes: `pulled from ${remote}`,
      status: 'raw', finished_file: null,
    };
    await manifest.append(take);
    json(res, 200, take);
  } catch (e) { fail(res, 500, e.message); }
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean); // e.g. ['api','takes',':id','file']

  try {
    if (!p.startsWith('/api')) return serveStatic(req, res, p);

    if (req.method === 'GET' && p === '/api/health') {
      const [ffv, scrcpy, adb] = await Promise.all([ff.version(), which('scrcpy'), which('adb')]);
      return json(res, 200, { ok: true, version: VERSION, ffmpeg: ffv, scrcpy: !!scrcpy, adb: !!adb, library: LIBRARY });
    }
    if (req.method === 'GET' && p === '/api/disk') {
      return json(res, 200, { freeGB: await diskFreeGB(LIBRARY) });
    }
    if (req.method === 'GET' && p === '/api/manifest') {
      return json(res, 200, manifest.load());
    }
    if (req.method === 'POST' && p === '/api/recordings') {
      return await ingestRecording(req, res, url);
    }

    if (seg[1] === 'rec' && seg[2] && req.method === 'POST') { // OBS-style streaming record
      if (seg[2] === 'start') return await recStart(req, res, url);
      if (seg[2] === 'chunk') return recChunk(req, res, url);
      if (seg[2] === 'finish') return await recFinish(req, res, url);
      if (seg[2] === 'abort') return recAbort(req, res, url);
      if (seg[2] === 'ping') return recPing(req, res, url);
      if (seg[2] === 'recover') return json(res, 200, { recovered: await recoverOrphans() });
    }

    // Reveal a take (or the library root) in Finder — so footage is easy to find on disk.
    if (seg[0] === 'api' && seg[1] === 'reveal' && req.method === 'POST') {
      const id = url.searchParams.get('id');
      const take = id ? manifest.get(id) : null;
      // ?dir=<name> opens a whole folder. Whitelisted by NAME, never a caller-supplied path —
      // this endpoint shells out to `open`, so accepting a path would open anything on disk.
      const dir = Object.hasOwn(DIRS, url.searchParams.get('dir')) ? DIRS[url.searchParams.get('dir')] : FOOTAGE_HOME;
      const args = take ? ['-R', path.join(LIBRARY, take.file)] : [dir];
      await run('open', args);
      return json(res, 200, { ok: true });
    }
    // Clear ALL takes: delete every file (+ finished) and empty the manifest.
    if (seg[0] === 'api' && seg[1] === 'takes' && !seg[2] && req.method === 'DELETE') {
      const { takes } = manifest.load();
      for (const t of takes) {
        for (const f of [t.file, t.finished_file]) {
          if (f) { try { fs.unlinkSync(path.join(LIBRARY, f)); } catch {} }
        }
      }
      const cleared = await manifest.clear();
      return json(res, 200, { cleared });
    }

    if (req.method === 'POST' && p === '/api/takes/adopt') return await adoptOrphans(req, res);

    if (seg[0] === 'api' && seg[1] === 'takes' && seg[2]) {
      const id = seg[2];
      if (req.method === 'GET' && seg[3] === 'file') {
        const take = manifest.get(id);
        if (!take) return fail(res, 404, 'unknown take');
        const wantFinished = url.searchParams.get('which') === 'finished' && take.finished_file;
        return serveVideo(req, res, path.join(LIBRARY, wantFinished ? take.finished_file : take.file));
      }
      if (req.method === 'POST' && seg[3] === 'finish') return await finishTake(req, res, id);
      if (req.method === 'PATCH' && !seg[3]) {
        const body = await readJsonBody(req);
        const patch = {};
        if ('notes' in body) patch.notes = String(body.notes).slice(0, 500);
        if ('reel' in body) patch.reel = body.reel ? safeSlug(body.reel) : null;
        const updated = await manifest.update(id, patch);
        return updated ? json(res, 200, updated) : fail(res, 404, 'unknown take');
      }
      if (req.method === 'DELETE' && !seg[3]) {
        const take = manifest.get(id);
        if (!take) return fail(res, 404, 'unknown take');
        for (const f of [take.file, take.finished_file]) {
          if (f) { try { fs.unlinkSync(path.join(LIBRARY, f)); } catch {} }
        }
        await manifest.remove(id);
        return json(res, 200, { deleted: id });
      }
    }

    if (req.method === 'GET' && p === '/api/scripts') return json(res, 200, listScripts());
    if (req.method === 'GET' && seg[1] === 'scripts' && seg[2]) {
      let slug = seg[2];
      try { slug = decodeURIComponent(slug); } catch { return fail(res, 400, 'bad script name'); }
      const match = listScripts().find((s) => s.slug === slug);
      if (!match) return fail(res, 404, 'unknown script');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(DIRS.scripts, match.file), 'utf8'));
    }

    if (seg[1] === 'phone') {
      if (req.method === 'GET' && seg[2] === 'status') return json(res, 200, await phone.deviceStatus());
      if (req.method === 'GET' && seg[2] === 'cameras') return json(res, 200, await phone.listCameras());
      if (req.method === 'GET' && seg[2] === 'camera-sizes') return json(res, 200, await phone.listCameraSizes());
      if (seg[2] === 'record') {
        if (req.method === 'POST' && seg[3] === 'start') return await phoneRecordStart(req, res);
        if (req.method === 'POST' && seg[3] === 'stop') return await phoneRecordStop(req, res);
        if (req.method === 'GET' && seg[3] === 'status') return json(res, 200, phone.recordStatus());
      }
      if (seg[2] === 'mirror') {
        if (req.method === 'POST' && seg[3] === 'start') return json(res, 200, await phone.startMirror());
        if (req.method === 'POST' && seg[3] === 'stop') return json(res, 200, await phone.stopMirror());
        if (req.method === 'GET' && seg[3] === 'status') return json(res, 200, phone.mirrorStatus());
      }
      if (seg[2] === 'wireless') {
        if (req.method === 'POST' && seg[3] === 'connect') return json(res, 200, await phone.connectWireless());
        if (req.method === 'POST' && seg[3] === 'disconnect') return json(res, 200, await phone.disconnectWireless());
        if (req.method === 'GET' && seg[3] === 'status') return json(res, 200, await phone.wirelessStatus());
      }
      if (req.method === 'GET' && seg[2] === 'media') {
        const list = await phone.listMedia();
        // Mark what is already on disk. Pulled copies are named "<stamp>-pull-<original name>",
        // so the original name is recoverable — that is what makes a re-pull obvious in the picker.
        const already = new Set();
        for (const dir of [ASSET_DIRS['phone-pull'], DIRS.images]) {
          try {
            for (const f of fs.readdirSync(dir)) {
              const m = f.match(/-pull-(.+)$/);
              if (m) already.add(m[1]);
            }
          } catch {}
        }
        list.items = list.items.map((it) => ({ ...it, pulled: already.has(it.name) }));
        return json(res, 200, list);
      }
      if (req.method === 'GET' && seg[2] === 'thumb') return await phoneThumb(req, res, url);
      if (req.method === 'GET' && seg[2] === 'pull' && seg[3] === 'progress') return json(res, 200, pullJob);
      if (req.method === 'POST' && seg[2] === 'pull' && !seg[3]) return await phonePull(req, res);
      if (req.method === 'POST' && seg[2] === 'pull-latest') return await phonePullLatest(req, res);
    }

    // Screener backdrop image — one persisted file, so the OBS-style backdrop survives restarts
    if (seg[1] === 'screener' && seg[2] === 'backdrop') {
      const binFile = path.join(DATA_DIR, 'backdrop.bin');
      const typeFile = path.join(DATA_DIR, 'backdrop.type');
      if (req.method === 'GET') {
        if (!fs.existsSync(binFile)) return fail(res, 404, 'no backdrop');
        const type = fs.existsSync(typeFile) ? fs.readFileSync(typeFile, 'utf8').trim() : 'image/png';
        res.writeHead(200, { 'Content-Type': type || 'image/png', 'Cache-Control': 'no-store' });
        return fs.createReadStream(binFile).pipe(res);
      }
      if (req.method === 'POST') {
        ensureDir(DATA_DIR);
        try { await streamToFile(req, binFile); }
        catch (e) { return fail(res, 500, `backdrop save failed: ${e.message}`); }
        fs.writeFileSync(typeFile, (req.headers['content-type'] || 'image/png').split(';')[0]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(binFile); } catch {}
        try { fs.unlinkSync(typeFile); } catch {}
        return json(res, 200, { ok: true });
      }
    }

    // Client error/event log → appended to <data>/segan-session.log (see public/js/log.js)
    if (req.method === 'POST' && p === '/api/log') {
      const entry = await readJsonBody(req).catch(() => null);
      if (entry && typeof entry === 'object') logToFile(entry);
      return json(res, 200, { ok: true });
    }

    fail(res, 404, `no route: ${req.method} ${p}`);
  } catch (e) {
    console.error(e);
    logToFile({ level: 'error', context: 'server', method: req.method, path: p, err: { message: e.message, stack: e.stack } });
    fail(res, 500, e.message);
  }
});

// ---------- boot ----------
const wantOpen = process.argv.includes('--open');
let port = Number(process.env.PORT) || 4321;
function listen(attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 10) { port += 1; listen(attempt + 1); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`Segan Sessions ${VERSION} → ${url}   (footage: ${FOOTAGE_HOME})`);
    if (wantOpen) {
      run('open', ['-a', 'Google Chrome', url]).then(({ code }) => {
        if (code !== 0) run('open', [url]);
      });
    }
  });
}

// Recover any recording a crash left as a .part before we start serving.
recoverOrphans()
  .then((r) => { if (r.length) console.log(`Recovered ${r.length} interrupted recording(s) from disk`); })
  .catch(() => {});
listen();
