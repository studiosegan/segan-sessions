// phone.js — Android capture via adb + scrcpy. One recording session at a time.
// Records to .mkv (crash-safe: survives USB unplug), remuxed to .mp4 by the caller on stop.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { run, which, nowStamp } from './util.js';

// PRIVATE ADB SERVER — the wireless-connect fix (root-caused 2026-08-21).
// Symptom: `adb connect <phone>:5555` returns a bogus "No route to host" while ping, nc and a plain
// python socket all reach that exact ip:port instantly, with ARP resolved and the route clean.
// Root cause: the SHARED adb server on the default port 5037 gets into a stuck state and reports
// EHOSTUNREACH for a host it can actually reach. Proof: at the same instant the 5037 server failed,
// a second server on port 5039 using the SAME binary connected first try (so did a copied binary on
// 5041). Not the network, not the phone, not macOS blocking adb.
// The fix is therefore to RECREATE the server properly before connecting — see resetAdbServer().
// (A private server port was tried and rejected: only one adb server can claim a USB device, so
// isolating Segan onto its own port makes the phone invisible over USB whenever any other adb
// server is running — Android Studio, a terminal, anything. Opt in with SEGAN_ADB_PORT if you ever
// want that isolation on a machine where nothing else uses adb.)
if (process.env.SEGAN_ADB_PORT) process.env.ANDROID_ADB_SERVER_PORT = process.env.SEGAN_ADB_PORT;
// Belt-and-braces: Segan never needs mDNS discovery (it reads the IP over USB and connects
// explicitly), and adb's mDNS backend has its own instability. Not the root cause above.
process.env.ADB_MDNS = '0';

let session = null; // { proc, file, meta, startedAt, exited, exitCode, stderrTail }
let mirror = null;  // { proc, startedAt, exited } — plain monitor window, never records

const ADB_PORT = process.env.ANDROID_ADB_SERVER_PORT || '5037'; // adb's default server port

async function adbServerAlive() {
  const { code, stdout } = await run('adb', ['devices'], { timeoutMs: 8000 }).catch(() => ({ code: 1, stdout: '' }));
  return code === 0 && /List of devices/i.test(stdout);
}

// Recreate Segan's private adb server from scratch, then verify it answers. A bare
// kill-server + start-server pair is NOT enough: the kill is asynchronous, so a start that races it
// silently leaves the OLD (stuck) server listening — which is exactly the state that produces the
// bogus "No route to host". So: kill, wait for the port to actually go quiet, start, then verify.
async function resetAdbServer() {
  await run('adb', ['kill-server'], { timeoutMs: 5000 }).catch(() => {});
  for (let i = 0; i < 20; i++) { // up to ~4s for the old listener to disappear
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${ADB_PORT}`, '-sTCP:LISTEN', '-t'], { timeoutMs: 3000 })
      .catch(() => ({ stdout: '' }));
    if (!stdout.trim()) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await run('adb', ['start-server'], { timeoutMs: 10000 }).catch(() => {});
  for (let i = 0; i < 15; i++) { // up to ~3s for the fresh server to answer
    if (await adbServerAlive()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Ground truth for reachability: a plain TCP connect from node. Repeatedly during debugging this
// succeeded instantly at the exact moment `adb connect` claimed "No route to host" — so it is what
// distinguishes a real network/phone problem from adb being stuck.
function tcpReachable(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(ms);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try { sock.connect(port, host); } catch { done(false); }
  });
}

// A pure mirror + control window (no --record). This is what Screen+Face captures as
// the phone source, and what you use to drive the phone from the Mac. Toggling it while
// one is already open just returns the running one.
export function mirrorStatus() {
  return { open: !!(mirror && !mirror.exited) };
}

export async function startMirror() {
  if (mirror && !mirror.exited) return { open: true, already: true };
  // Cap fps + size + bitrate: the mirror is a monitor/capture source, not a master file.
  // scrcpy defaults to 60fps full-res which doubles the decode/render heat on the Mac (and
  // the encode load on the phone) for no visible gain in a 1080-wide canvas.
  const serial = await pickSerial();
  const args = [
    '--max-fps=30', '--max-size=1920', '--video-bit-rate=8M',
    '--window-title=Segan Sessions — PHONE MIRROR (control · not recording)',
  ];
  if (serial) args.unshift('-s', serial);
  const proc = spawn('scrcpy', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const m = { proc, startedAt: Date.now(), exited: false, stderrTail: '' };
  mirror = m;
  const tail = (d) => { m.stderrTail = (m.stderrTail + d.toString()).slice(-2000); };
  proc.stdout.on('data', tail);
  proc.stderr.on('data', tail);
  proc.on('close', () => { m.exited = true; });
  proc.on('error', (e) => { m.exited = true; m.stderrTail += `\nspawn error: ${e.message}`; });
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (m.exited) {
        if (mirror === m) mirror = null;
        reject(new Error(`scrcpy mirror exited early: ${m.stderrTail.slice(-500)}`));
      } else {
        resolve({ open: true });
      }
    }, 2000);
  });
}

export async function stopMirror() {
  if (!mirror || mirror.exited) { mirror = null; return { open: false }; }
  const m = mirror;
  m.proc.kill('SIGINT');
  await new Promise((resolve) => {
    const t = setTimeout(() => { m.proc.kill('SIGKILL'); resolve(); }, 3000);
    m.proc.on('close', () => { clearTimeout(t); resolve(); });
  });
  mirror = null;
  return { open: false };
}

export async function toolStatus() {
  const [adb, scrcpy] = await Promise.all([which('adb'), which('scrcpy')]);
  return { adb: !!adb, scrcpy: !!scrcpy };
}

// When both USB + WiFi are connected, pick the WiFi device so scrcpy doesn't error on ambiguity
// (and so mirroring uses the wireless link the user wants). Returns null if none.
export async function pickSerial() {
  const { stdout } = await run('adb', ['devices'], { timeoutMs: 8000 });
  const devs = stdout.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)).filter((a) => a[1] === 'device').map((a) => a[0]);
  return devs.find((d) => /:\d+$/.test(d)) || devs[0] || null; // prefer ip:port (wireless)
}

// While a wireless connect is in flight, the 3s status poller must NOT run adb: its `adb devices`
// races connectWireless's kill/start/connect and corrupts the shared adb server → the connect works
// in isolation but fails with a bogus "No route to host" under concurrent polling. So the exported
// status calls return the last cached value while `wirelessBusy` is set; connectWireless uses the
// raw `_deviceStatus` internally.
let wirelessBusy = false;
let lastDeviceStatus = { installed: true, connected: false };
let lastWirelessStatus = { wireless: false, address: null };

export async function deviceStatus() {
  if (wirelessBusy) return lastDeviceStatus;
  lastDeviceStatus = await _deviceStatus();
  return lastDeviceStatus;
}

async function _deviceStatus() {
  const tools = await toolStatus();
  if (!tools.adb) return { installed: false, connected: false };
  const { stdout } = await run('adb', ['devices', '-l'], { timeoutMs: 10000 });
  const lines = stdout.trim().split('\n').slice(1).filter((l) => l.trim());
  if (!lines.length) return { installed: true, connected: false };
  const parts = lines[0].trim().split(/\s+/);
  const serial = parts[0];
  const state = parts[1]; // device | unauthorized | offline
  const model = (lines[0].match(/model:(\S+)/) || [])[1]?.replace(/_/g, ' ') || null;
  const status = { installed: true, connected: true, authorized: state === 'device', state, serial, model };

  if (status.authorized) {
    // scrcpy camera streaming needs Android 12+ (SDK 31) — screen mirroring works on anything.
    // Target this serial: with both USB + WiFi connected a bare `adb shell` is ambiguous.
    const { stdout: props } = await run('adb',
      ['-s', serial, 'shell', 'getprop ro.build.version.release; getprop ro.build.version.sdk'], { timeoutMs: 8000 });
    const [release, sdk] = props.trim().split('\n').map((s) => s.trim());
    status.androidVersion = release || null;
    status.androidSdk = Number(sdk) || null;
    status.cameraSupported = status.androidSdk ? status.androidSdk >= 31 : null;
  }
  return status;
}

export async function listCameras() {
  // scrcpy prints the list then exits non-zero; parse whatever it printed.
  const { stdout, stderr } = await run('scrcpy', ['--list-cameras'], { timeoutMs: 20000 });
  const text = stdout + stderr;
  const cams = [];
  for (const m of text.matchAll(/--camera-id=(\d+)\s+\(([^,]+),\s*(\d+)x(\d+)(?:,\s*fps=\[([^\]]*)\])?/g)) {
    cams.push({
      id: m[1], facing: m[2].trim(), maxWidth: Number(m[3]), maxHeight: Number(m[4]),
      fps: m[5] ? m[5].split(',').map((s) => Number(s.trim())).filter(Boolean) : [],
    });
  }
  return { cameras: cams, raw: cams.length ? undefined : text.slice(-800) };
}

export async function listCameraSizes() {
  const { stdout, stderr } = await run('scrcpy', ['--list-camera-sizes'], { timeoutMs: 25000 });
  return { raw: (stdout + stderr).slice(-4000) };
}

export function isRecording() {
  return !!(session && !session.exited);
}

export function recordStatus() {
  if (!session) return { recording: false };
  let bytes = 0;
  try { bytes = fs.statSync(session.file).size; } catch {}
  return {
    recording: !session.exited,
    file: session.file,
    elapsed: Math.round((Date.now() - session.startedAt) / 1000),
    bytes,
    meta: session.meta,
    exitCode: session.exitCode ?? null,
  };
}

export function startRecord({ source, cameraId, facing = 'back', size, fps = 30, codec = 'h265', bitrate, file }) {
  if (isRecording()) throw new Error('a phone recording is already running');
  const args = [];
  if (source === 'camera') {
    args.push('--video-source=camera');
    if (cameraId != null && cameraId !== '') args.push(`--camera-id=${cameraId}`);
    else args.push(`--camera-facing=${facing}`);
    if (size) args.push(`--camera-size=${size}`);
    args.push(`--camera-fps=${fps}`);
    args.push(`--video-codec=${codec}`);
    args.push(`--video-bit-rate=${bitrate || '20M'}`);
    args.push('--window-title=Segan Sessions — PHONE CAMERA (recording)');
  } else {
    args.push(`--video-bit-rate=${bitrate || '12M'}`);
    args.push('--window-title=Segan Sessions — PHONE SCREEN (recording)');
  }
  args.push(`--record=${file}`);

  const proc = spawn('scrcpy', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // capture the session object — handlers must never touch a LATER session via the module variable
  const s = { proc, file, meta: { source, cameraId, facing, size, fps, codec }, startedAt: Date.now(), exited: false, stderrTail: '' };
  session = s;
  const tail = (d) => { s.stderrTail = (s.stderrTail + d.toString()).slice(-2000); };
  proc.stdout.on('data', tail);
  proc.stderr.on('data', tail);
  proc.on('close', (code) => { s.exited = true; s.exitCode = code; });
  proc.on('error', (e) => { s.exited = true; s.stderrTail += `\nspawn error: ${e.message}`; });

  // fail fast if scrcpy dies immediately (no device, camera busy, bad size…)
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (s.exited) {
        if (session === s) session = null;
        reject(new Error(`scrcpy exited early: ${s.stderrTail.slice(-500)}`));
      } else {
        resolve({ file, meta: s.meta });
      }
    }, 2500);
  });
}

// SIGINT lets scrcpy finalize the recording cleanly; escalate if it hangs.
export async function stopRecord() {
  if (!session) throw new Error('no phone recording in progress');
  const s = session;
  if (!s.exited) {
    s.proc.kill('SIGINT');
    await new Promise((resolve) => {
      const t1 = setTimeout(() => s.proc.kill('SIGTERM'), 5000);
      const t2 = setTimeout(() => { s.proc.kill('SIGKILL'); resolve(); }, 10000);
      s.proc.on('close', () => { clearTimeout(t1); clearTimeout(t2); resolve(); });
      if (s.exited) { clearTimeout(t1); clearTimeout(t2); resolve(); }
    });
  }
  session = null;
  const exists = fs.existsSync(s.file) && fs.statSync(s.file).size > 0;
  return { file: s.file, meta: s.meta, ok: exists, stderrTail: s.stderrTail.slice(-800), startedAt: s.startedAt };
}

// ---- wireless (control the phone from a tripod, no long cable) ----
// Flip the currently-USB-connected phone to TCP/IP so it can be unplugged and driven over WiFi.
// The camera app still records full quality on the phone; plug USB back in only to Pull latest.
export async function connectWireless() {
  wirelessBusy = true; // freeze the poller off adb for the entire connect (prevents server corruption)
  try {
  const dev = await _deviceStatus();
  if (!dev.connected || !dev.authorized) {
    throw new Error('Plug the phone in via USB and authorize it first, then hit Go wireless.');
  }
  const serial = dev.serial;
  // read the phone's WiFi IP while it's the single USB device
  const { stdout } = await run('adb', ['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], { timeoutMs: 8000 });
  const ip = (stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/) || [])[1];
  if (!ip) throw new Error('Could not read the phone’s WiFi IP — turn WiFi on and join the same network as this Mac.');
  // Re-arm TCP mode over USB every time — cheap, and it guarantees adbd is listening on :5555 no
  // matter what the phone did since the last session. (The Android 11+ "Wireless debugging" toggle
  // does NOT conflict with this: the legacy :5555 and the TLS listeners coexist by design.)
  // Same-subnet sanity check FIRST — a guest network / AP isolation puts the phone on a different
  // network than the Mac, and no amount of adb retrying can cross that ("No route to host").
  const sub = (s) => s.split('.').slice(0, 3).join('.');
  const macIp = (await run('ipconfig', ['getifaddr', 'en0'], { timeoutMs: 3000 }).then((r) => r.stdout.trim()).catch(() => ''))
    || (await run('ipconfig', ['getifaddr', 'en1'], { timeoutMs: 3000 }).then((r) => r.stdout.trim()).catch(() => ''));
  if (macIp && sub(macIp) !== sub(ip)) {
    throw new Error(`Phone (${ip}) and this Mac (${macIp}) are on different networks. Join BOTH to the same WiFi — not a guest network (guest WiFi blocks device-to-device). Then try again.`);
  }
  await run('adb', ['-s', serial, 'tcpip', '5555'], { timeoutMs: 8000 });
  await new Promise((r) => setTimeout(r, 2500)); // adbd needs a moment to restart in TCP mode
  const address = `${ip}:5555`;
  // A stuck adb server IS the cause of the bogus "No route to host" — recreate ours cleanly first,
  // and drop stale transports: a half-dead one for this address makes adb replay its last error.
  await run('adb', ['disconnect'], { timeoutMs: 5000 }).catch(() => {});
  await resetAdbServer();
  // Knock on :5555 with nc before each connect — it wakes the phone's WiFi radio from power-save.
  // Track whether the port is EVER reachable: if not, the phone isn't listening (Wireless debugging
  // off) — a very different fix than an adb hiccup, so we say so precisely.
  // Wake + HOLD the phone's WiFi radio during the connect. An idle (screen-off) Samsung radio stops
  // answering inbound, so the Mac-initiated adb connect gets EHOSTUNREACH — and the radio only wakes
  // when the PHONE transmits. So have the phone ping the Mac over USB for the whole connect window.
  let keepalive = null;
  if (macIp) { try { keepalive = spawn('adb', ['-s', serial, 'shell', 'ping', '-c', '30', macIp], { stdio: 'ignore' }); } catch {} }
  // Ride out the stuck-adb window. Measured behaviour: right after a USB replug / WiFi reconnect /
  // app restart, `adb connect` returns a bogus "No route to host" for up to ~a minute even though a
  // raw TCP socket to the same ip:port connects instantly — then it heals on its own. The old loop
  // gave up after ~12s, i.e. exactly when the user tries. So: keep retrying to a deadline, and
  // recreate the adb server between rounds (a fresh server is what breaks the stuck state).
  let lastErr = '', portReachable = false;
  const deadline = Date.now() + 60_000;
  try {
    for (let round = 0; Date.now() < deadline; round++) {
      if (round > 0) await resetAdbServer();
      for (let i = 0; i < 6 && Date.now() < deadline; i++) {
        if (await tcpReachable(ip, 5555)) portReachable = true;
        const { stdout: out, stderr } = await run('adb', ['connect', address], { timeoutMs: 10000 });
        if (/connected|already/i.test(out)) return { address, ip };
        lastErr = (out + stderr).trim();
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  } finally { try { keepalive?.kill('SIGKILL'); } catch {} }
  if (!portReachable) {
    throw new Error(`Can't reach ${ip}:5555 at all. Wake the phone, confirm it's on the same WiFi as this Mac, and make sure USB debugging is still authorised. Then tap Go wireless again.`);
  }
  // The phone answered a raw TCP connect but adb refused for a full minute — adb's own stuck state.
  throw new Error(`The phone is reachable but adb stayed stuck for 60s (${lastErr.slice(-60)}). This clears itself: wait ~a minute and tap Go wireless again.`);
  } finally {
    wirelessBusy = false;
  }
}

export async function disconnectWireless() {
  await run('adb', ['disconnect'], { timeoutMs: 5000 });
  return { wireless: false };
}

export async function wirelessStatus() {
  if (wirelessBusy) return lastWirelessStatus;
  const { stdout } = await run('adb', ['devices'], { timeoutMs: 8000 });
  const line = stdout.split('\n').find((l) => /^\d+\.\d+\.\d+\.\d+:\d+\s+device/.test(l.trim()));
  lastWirelessStatus = { wireless: !!line, address: line ? line.trim().split(/\s+/)[0] : null };
  return lastWirelessStatus;
}

// ---- camera roll browsing (the "Pull from phone" picker) ----
// One `stat` call gives epoch|bytes|path for the whole camera roll; parsing that is far more
// reliable than scraping `ls -l` (locale-dependent columns, spaces in names).
// Scan EVERY DCIM subfolder, not just Camera: Samsung puts screen recordings in
// "/sdcard/DCIM/Screen recordings", screenshots in "/sdcard/DCIM/Screenshots", and there are
// Videocaptures / Expert RAW / Restored too. One glob covers whatever the phone happens to have.
const MEDIA_GLOBS = ['/sdcard/DCIM/*/*', '/sdcard/DCIM/*', '/sdcard/Movies/*'];
const VIDEO_EXT = ['mp4', 'mkv', 'mov', '3gp', 'webm', 'm4v'];
const PHOTO_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'dng'];

export function mediaKind(remotePath) {
  const ext = (remotePath.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (PHOTO_EXT.includes(ext)) return 'photo';
  return null;
}

// Everything shootable in the camera roll, newest first. Non-media (thumbnails, .pending files)
// is dropped so the picker only ever offers things worth pulling.
export async function listMedia({ limit = 400 } = {}) {
  const globs = MEDIA_GLOBS.join(' ');
  const { stdout } = await run('adb', ['shell', `stat -c '%Y|%s|%n' ${globs} 2>/dev/null`], { timeoutMs: 45000 });
  const items = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|(.+)$/);
    if (!m) continue;
    const [, mtime, size, remote] = m;
    const kind = mediaKind(remote);
    if (!kind) continue;
    const parts = remote.split('/');
    items.push({
      remote, name: parts.pop(), folder: parts.pop() || '', kind,
      size: Number(size), mtime: Number(mtime) * 1000,
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { items: items.slice(0, limit) };
}

// ---- thumbnails ----
// Photos are cheap: stream the whole file (a 2 MB jpg lands in ~0.2 s over USB) and downscale.
// Videos are the interesting case: an Android MP4 keeps its index (moov) at the END, so the first
// few MB alone are undecodable ("moov atom not found"). The trick is to fetch the head AND the tail
// into a file of the ORIGINAL length — a sparse file, so it costs ~7 MB on disk regardless — which
// keeps moov's byte offsets valid and lets ffmpeg decode frame 1. Verified on a 4.8 GB clip:
// 7.4 MB transferred, thumbnail out.
const THUMB_HEAD = 4 * 1024 * 1024;
const THUMB_TAIL = 3 * 1024 * 1024;

// adb writes binary to stdout; run() buffers as UTF-8 and would corrupt it, so stream to a file.
function adbToFile(args, outFile, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outFile);
    const proc = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '', code = null;
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (c) => { code = c; });
    proc.stdout.pipe(ws);
    ws.on('finish', () => {
      clearTimeout(timer);
      if (code === 0 || fs.statSync(outFile).size > 0) resolve();
      else reject(new Error(err.slice(-200) || `adb exited ${code}`));
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Only two adb transfers at a time: scrolling a 126-tile grid must not spawn 126 pulls at once.
let thumbActive = 0;
const thumbQueue = [];
function thumbSlot() {
  if (thumbActive < 2) { thumbActive++; return Promise.resolve(); }
  return new Promise((r) => thumbQueue.push(r)).then(() => { thumbActive++; });
}
function thumbRelease() { thumbActive--; const n = thumbQueue.shift(); if (n) n(); }

export async function makeThumb(remote, size, outFile) {
  const kind = mediaKind(remote);
  if (!kind) throw new Error('not media');
  await thumbSlot();
  const tmp = `${outFile}.src`;
  const tailTmp = `${outFile}.tail`;
  try {
    if (kind === 'photo') {
      await adbToFile(['exec-out', `cat '${remote}'`], tmp);
    } else {
      await adbToFile(['exec-out', `dd if='${remote}' bs=1M count=4 2>/dev/null`], tmp);
      if (size > THUMB_HEAD + THUMB_TAIL) {
        fs.truncateSync(tmp, size); // sparse: keeps moov's offsets valid, costs nothing on disk
        const skipMB = Math.floor((size - THUMB_TAIL) / 1048576);
        await adbToFile(['exec-out', `dd if='${remote}' bs=1M skip=${skipMB} 2>/dev/null`], tailTmp);
        const tail = fs.readFileSync(tailTmp);
        const fd = fs.openSync(tmp, 'r+');
        try { fs.writeSync(fd, tail, 0, tail.length, size - tail.length); } finally { fs.closeSync(fd); }
      }
    }
    const { code, stderr } = await run('ffmpeg',
      ['-y', '-v', 'error', '-i', tmp, '-frames:v', '1', '-vf', 'scale=320:-1', outFile],
      { timeoutMs: 60000 });
    if (code !== 0 || !fs.existsSync(outFile)) throw new Error(`thumb failed: ${stderr.slice(-200)}`);
    return outFile;
  } finally {
    for (const f of [tmp, tailTmp]) { try { fs.unlinkSync(f); } catch {} }
    thumbRelease();
  }
}

// Copy ONE file to destDir. Timestamp prefix means pulling the same clip twice never overwrites
// an earlier copy. Generous timeout: camera clips here run to 5 GB.
export async function pullOne(remote, destDir, onDest) {
  const base = remote.split('/').pop();
  const dest = `${destDir}/${nowStamp()}-pull-${base}`;
  if (onDest) onDest(dest); // lets the caller stat the growing file for progress
  const { code, stderr } = await run('adb', ['pull', remote, dest], { timeoutMs: 30 * 60 * 1000 });
  if (code !== 0) throw new Error(`adb pull failed: ${stderr.slice(-300)}`);
  return dest;
}

// Newest video from the phone camera roll (shot in the native camera app = max quality).
export async function pullLatest(destDir) {
  const dirs = ['/sdcard/DCIM/Camera', '/sdcard/DCIM/Videos', '/sdcard/DCIM'];
  for (const dir of dirs) {
    const { code, stdout } = await run('adb',
      ['shell', `ls -t ${dir}/*.mp4 2>/dev/null | head -1`], { timeoutMs: 15000 });
    const remote = stdout.trim().split('\n')[0];
    if (code === 0 && remote && remote.endsWith('.mp4')) {
      const base = remote.split('/').pop();
      // timestamp prefix: pulling twice must never overwrite an earlier take's file
      const dest = `${destDir}/${nowStamp()}-pull-${base}`;
      const pull = await run('adb', ['pull', remote, dest], { timeoutMs: 10 * 60 * 1000 });
      if (pull.code !== 0) throw new Error(`adb pull failed: ${pull.stderr.slice(-300)}`);
      return { remote, dest };
    }
  }
  throw new Error('no .mp4 found in /sdcard/DCIM — shoot a video in the camera app first');
}
