// Drives the REAL Screener UI end to end — not just the recorder module — because the bugs that
// cost real footage live in the wiring: which mic reaches the file, whether the camera really turns
// off, whether the call audio is captured (a meeting recorded without system audio silently loses
// the other side of the call). Chrome's fake devices supply a camera and a beeping mic; getDisplayMedia can't be
// faked headless, so it is stubbed with a synthetic screen. Every audio claim is checked on the
// SAVED FILE with ffmpeg, never inside the page — including mute, measured as silence in the
// exact stretch of the take that was muted.
//
// Client logs are captured here instead of reaching the session log, and the server runs on a
// throwaway library + data dir, so a test run never touches real footage or settings.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { mktmp, bootServer, probe } from './_util.mjs';

const tmp = mktmp();
let child, browser;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

function finish(crash) {
  try { child?.kill('SIGKILL'); } catch {}
  if (process.env.SEGAN_TEST_KEEP) console.log(`  (kept for inspection: ${tmp})`);
  else try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.ok).length;
  if (crash) { console.error(`FAIL: crashed after ${results.length} checks — ${crash}`); process.exit(1); }
  if (bad) { console.error(`FAIL: ${bad} of ${results.length} Screener checks failed`); process.exit(1); }
  console.log(`PASS: mic, camera switch, mute, codec-fallback race — all ${results.length} checks`);
  process.exit(0);
}

// Real decode errors in the saved file (both streams). The null muxer's "non monotonically
// increasing dts" notes are Chrome's variable frame rate, present in every good take — not damage.
function decodeErrors(file) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return (r.stderr || '').split('\n').filter((l) => l.trim() && !/non monotonically increasing dts/.test(l)).length;
}

// Loudest sample of the file's audio in dB (≈ -91 is digital silence); null = no audio stream.
// Optional window [ss, ss+t] in seconds. Chrome's fake mic beeps at 0 dB every 0.5 s, so any
// unmuted window of ≥0.6 s peaks near 0 dB and a muted one stays near silence.
function maxVolume(file, ss, t) {
  const win = ss != null ? ['-ss', String(ss), '-t', String(t)] : [];
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'info', ...win, '-i', file, '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' });
  const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr || '');
  return m ? Number(m[1]) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

try {
  const boot = await bootServer(tmp); child = boot.child; const base = boot.base;
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });

  await context.addInitScript(() => {
    localStorage.setItem('ss-mode', 'composite');
    localStorage.setItem('ss-countdown', '0');
    // Track every getUserMedia stream so the test can see which tracks are live (= camera light).
    window.__gum = [];
    const md = navigator.mediaDevices;
    const realGUM = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => { const s = await realGUM(c); window.__gum.push(s); return s; };
    // Fault injection for the codec-fallback race. Every take starts with Chrome refusing the first
    // H.264 profile, and the recorder falls back to the next codec. When that refusal comes LATE the
    // failed encoder has already produced bytes, and Chrome flushes them AFTER stop() — into the new
    // take, where they break the video and drop the audio (real take 2026-09-12: 19,915 decode
    // errors, no audio track; failure came 641 ms in). Headless Chrome always fails in ~15 ms with
    // nothing to flush, so with window.__lateFail set, the first recorder of a take fails at 600 ms
    // and flushes 4 KB after stop(), exactly like that take.
    const RealMR = window.MediaRecorder;
    window.MediaRecorder = class extends RealMR {
      constructor(stream, opts) {
        super(stream, opts);
        this.__late = !!window.__lateFail && /avc1\.42E01E/.test(opts?.mimeType || '');
      }
      start(ts) {
        if (!this.__late) return super.start(ts);
        setTimeout(() => this.dispatchEvent(new Event('error')), 600);
      }
      stop() {
        if (!this.__late) return super.stop();
        setTimeout(() => {
          this.dispatchEvent(new BlobEvent('dataavailable', { data: new Blob([new Uint8Array(4096).fill(0x41)], { type: 'video/mp4' }) }));
          this.dispatchEvent(new Event('stop'));
        }, 0);
      }
    };
    window.MediaRecorder.isTypeSupported = RealMR.isTypeSupported.bind(RealMR);
    // Synthetic "screen": an animated canvas. window.__callAudio = true adds a 440 Hz tone as the
    // shared system audio (what Chrome's "Share with system audio" switch would add).
    md.getDisplayMedia = async () => {
      const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
      const g = cv.getContext('2d'); let n = 0;
      setInterval(() => {
        g.fillStyle = `hsl(${(n++ * 7) % 360} 60% 40%)`; g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff'; g.font = '64px sans-serif'; g.fillText(String(n), 40, 100);
      }, 33);
      const s = cv.captureStream(30);
      if (window.__callAudio) {
        const ac = new AudioContext(); const o = ac.createOscillator(); o.frequency.value = 440;
        const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
        s.addTrack(d.stream.getAudioTracks()[0]);
      }
      return s;
    };
  });

  const page = await context.newPage();
  const logs = [];
  await page.route('**/api/log', async (r) => {
    try { logs.push(JSON.parse(r.request().postData() || '{}')); } catch {}
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/screener/backdrop', (r) =>
    r.request().method() === 'GET' ? r.fulfill({ status: 404, body: '' }) : r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  const live = (kind) => page.evaluate((k) => window.__gum
    .flatMap((s) => (k === 'video' ? s.getVideoTracks() : s.getAudioTracks()))
    .filter((t) => t.readyState === 'live').length, kind);
  const takeCount = async () => (await (await fetch(`${base}/api/manifest`)).json()).takes.length;
  const lastTake = async () => { const t = (await (await fetch(`${base}/api/manifest`)).json()).takes; return t[t.length - 1]; };
  const isRecording = () => page.evaluate(() => document.getElementById('btn-record').classList.contains('recording'));

  // `during(at)` runs while recording; at(s) waits until s seconds into the take.
  async function recordTake(secs, during) {
    const before = await takeCount();
    await page.click('#btn-record');
    await waitFor(isRecording, 6000);
    const t0 = Date.now();
    const at = (s) => sleep(Math.max(0, s * 1000 - (Date.now() - t0)));
    const shapeLocked = await page.$eval('#sel-bubble-shape', (e) => e.disabled);
    if (during) await during(at);
    await at(secs);
    await page.click('#btn-record');
    await waitFor(async () => (await takeCount()) > before, 25000, 300);
    await waitFor(async () => !(await isRecording()), 10000);
    const take = (await takeCount()) > before ? await lastTake() : null;
    return { take, shapeLocked, file: take ? path.join(tmp, take.file) : null };
  }

  await page.goto(`${base}/`);
  await waitFor(() => page.evaluate(() => !document.getElementById('panel-composite').hidden));

  // ---- the mic is its own stream, visible and live in Screener ----
  check('Microphone picker is visible in Screener', await page.isVisible('#sel-mic'));
  check('mic opens in Screener on its own', await waitFor(async () => (await live('audio')) >= 1));
  check('camera is on while the bubble is a circle', await waitFor(async () => (await live('video')) === 1));
  await page.uncheck('#chk-autofinish-comp');
  await page.click('#btn-pick-screen');
  await waitFor(() => page.evaluate(() => !document.getElementById('btn-record').disabled));

  // ---- a share WITHOUT system audio is flagged the moment you pick (the 2026-09-25 loss) ----
  check('sharing without system audio shows "Call audio is off"', await waitFor(() => page.isVisible('#call-audio-warn')));
  check('no Call-audio meter when the share has no audio', !(await page.isVisible('#call-meter')));
  await page.click('#btn-call-audio-ok');
  check('"Not needed" hides the warning (a tutorial needs only your mic)',
    await waitFor(async () => !(await page.isVisible('#call-audio-warn'))));

  // ---- bubble Off = camera OFF, and the voice still records ----
  await page.selectOption('#sel-bubble-shape', 'off');
  check('bubble "Off" turns the camera off (green light out)', await waitFor(async () => (await live('video')) === 0));
  check('mic stays live with the camera off', (await live('audio')) >= 1);

  const off = await recordTake(4);
  check('a take saves with the camera off', !!off.take);
  check('bubble setting is locked during a take that started with it off', off.shapeLocked === true);
  check('camera-off take records on the light raw path', off.take?.device === 'screen (raw)', off.take?.device);
  check('camera-off take has an audio track', off.file && probe(off.file).acodec === 'aac', off.file && probe(off.file).acodec);
  const vOff = off.file ? maxVolume(off.file) : null;
  check('your voice is in the camera-off take (mic not silent)', vOff !== null && vOff > -40, `max ${vOff} dB`);
  const eOff = off.file ? decodeErrors(off.file) : -1;
  check('camera-off take decodes cleanly (no codec-fallback leftovers)', eOff === 0, `${eOff} decode errors`);
  check('bubble setting unlocks after the take', !(await page.$eval('#sel-bubble-shape', (e) => e.disabled)));
  check('camera stays off after the take', (await live('video')) === 0);

  // ---- bubble back on = camera on, and the voice still records ----
  await page.selectOption('#sel-bubble-shape', 'circle');
  check('bubble "Circle" turns the camera back on', await waitFor(async () => (await live('video')) === 1));
  const on = await recordTake(3);
  check('bubble take records on the composite path', on.take?.device === 'screen+bubble composite', on.take?.device);
  check('bubble setting stays free during a take that started with it on', on.shapeLocked === false);
  const vOn = on.file ? maxVolume(on.file) : null;
  check('your voice is in the bubble take', vOn !== null && vOn > -40, `max ${vOn} dB`);
  const eOn = on.file ? decodeErrors(on.file) : -1;
  check('bubble take decodes cleanly (no codec-fallback leftovers)', eOn === 0, `${eOn} decode errors`);

  // ---- a codec that fails LATE must leave no trace in the take ----
  await page.evaluate(() => { window.__lateFail = true; });
  const late = await recordTake(3);
  await page.evaluate(() => { window.__lateFail = false; });
  check('late codec failure: the take still saves', !!late.take);
  const vLate = late.file ? maxVolume(late.file) : null;
  check('late codec failure: your voice is still in the take', vLate !== null && vLate > -40, `max ${vLate} dB`);
  const eLate = late.file ? decodeErrors(late.file) : -1;
  check('late codec failure: the dead codec\'s bytes never reach the file', eLate === 0, `${eLate} decode errors`);

  // ---- mute mid-take: only your voice leaves; the recording keeps rolling ----
  const muted = await page.evaluate(() => document.getElementById('btn-mute').classList.contains('muted'));
  check('a session starts unmuted', muted === false);
  let badgeWhileMuted = false, badgeAfter = true;
  const mid = await recordTake(6, async (at) => {
    await at(2); await page.keyboard.press('m');   // mute at ~2 s (keyboard shortcut)
    await sleep(300); badgeWhileMuted = await page.isVisible('#mute-badge');
    await at(4); await page.click('#btn-mute');    // unmute at ~4 s (the button)
    await sleep(300); badgeAfter = await page.isVisible('#mute-badge');
  });
  const [m1, m2, m3] = mid.file ? [maxVolume(mid.file, 0.4, 1.2), maxVolume(mid.file, 2.5, 1.0), maxVolume(mid.file, 4.5, 1.2)] : [];
  check('mute mid-take: voice before the mute', m1 > -20, `${m1} dB`);
  check('mute mid-take: silence while muted', m2 !== null && m2 < -50, `${m2} dB`);
  check('mute mid-take: voice again after unmuting', m3 > -20, `${m3} dB`);
  check('mute mid-take: the take is one continuous file', mid.file && probe(mid.file).dur > 5.5, mid.file && `${probe(mid.file).dur.toFixed(1)} s`);
  check('"MIC MUTED" badge shows while muted, hides after', badgeWhileMuted && !badgeAfter);

  // ---- recording while muted: a loud warning, and truly no voice in the file ----
  await page.keyboard.press('m');
  let warned = '';
  const pre = await recordTake(2, async () => { await sleep(200); warned = await page.textContent('#toast'); });
  const vPre = pre.file ? maxVolume(pre.file) : null;
  check('pressing Record while muted warns you', /MUTED/.test(warned || ''), warned);
  check('a take recorded muted has no voice in it', vPre !== null && vPre < -50, `max ${vPre} dB`);
  await page.keyboard.press('m'); // unmute for the rest

  // ---- a share WITH system audio: the meter moves, and the call is in the file even when you mute ----
  await page.evaluate(() => { window.__callAudio = true; });
  await page.click('#btn-pick-screen');
  await waitFor(() => page.evaluate(() => !document.getElementById('btn-record').disabled));
  check('sharing WITH system audio: no warning', await waitFor(async () => !(await page.isVisible('#call-audio-warn'))));
  check('the Call-audio meter appears and moves', await waitFor(() => page.evaluate(() =>
    !document.getElementById('call-meter').hidden && parseFloat(document.getElementById('call-meter-fill').style.width) > 20)));
  await page.keyboard.press('m'); // mute yourself
  let repickLocked = false;
  const call = await recordTake(2, async () => { await sleep(300); repickLocked = await page.$eval('#btn-repick-audio', (e) => e.disabled); });
  await page.keyboard.press('m');
  const vCall = call.file ? maxVolume(call.file) : null;
  check('muting yourself never mutes the call: the call audio is in the take', vCall !== null && vCall > -20, `max ${vCall} dB`);
  check('Re-pick is locked during a take (it would cut the recorded screen)', repickLocked);
  await page.evaluate(() => { window.__callAudio = false; });

  // ---- Camera mode still records your voice through the (moved) Microphone picker ----
  await page.click('.tab[data-mode="camera"]');
  await waitFor(() => page.evaluate(() => !document.getElementById('panel-camera').hidden));
  check('Microphone picker is visible in Camera mode', await page.isVisible('#sel-mic'));
  await page.uncheck('#chk-autofinish');
  await waitFor(() => page.evaluate(() => !document.getElementById('btn-record').disabled), 10000);
  const cam = await recordTake(5, async (at) => {
    await at(1.8); await page.keyboard.press('m');
    await at(3.4); await page.keyboard.press('m');
  });
  const [c1, c2, c3] = cam.file ? [maxVolume(cam.file, 0.3, 1.2), maxVolume(cam.file, 2.3, 0.8), maxVolume(cam.file, 3.9, 0.9)] : [];
  check('Camera mode: your voice is in the take', c1 > -20, `${c1} dB`);
  check('Camera mode: mute silences only the muted stretch', c2 !== null && c2 < -50 && c3 > -20, `${c2} dB muted, ${c3} dB after`);
  await page.click('.tab[data-mode="phone"]');
  check('Microphone picker is hidden in Phone mode (phone uses its own audio)',
    await waitFor(async () => !(await page.isVisible('#sel-mic'))));
  check('mute button is hidden in Phone mode', !(await page.isVisible('#btn-mute')));

  // ---- mute is never remembered: a new session starts unmuted ----
  await page.click('.tab[data-mode="composite"]');
  await waitFor(() => page.evaluate(() => typeof document.getElementById('btn-pick-screen').onclick === 'function'));
  await page.keyboard.press('m');
  await page.reload();
  await waitFor(() => page.evaluate(() => !document.getElementById('panel-composite').hidden));
  check('mute is not remembered after a reload',
    !(await page.evaluate(() => document.getElementById('btn-mute').classList.contains('muted'))) && !(await page.isVisible('#mute-badge')));

  if (process.env.SEGAN_TEST_KEEP) {
    for (const [label, t] of [['off', off.take], ['on', on.take]]) console.log(`  [take ${label}]`, JSON.stringify(t));
    for (const l of logs) if (l.level === 'error' || /fallback|record-start/i.test(l.context || '')) console.log('  [log]', JSON.stringify(l));
  }

  // ---- the log now says what audio each take captured ----
  const starts = logs.filter((l) => l.context === 'record-start');
  check('record-start log records hasMic + hasSystemAudio',
    starts.length >= 3 && starts.every((s) => s.hasMic === true)
      && starts.some((s) => s.hasSystemAudio === true) && starts.some((s) => s.hasSystemAudio === false),
    JSON.stringify(starts.map(({ hasMic, hasSystemAudio }) => ({ hasMic, hasSystemAudio }))));

  finish();
} catch (e) {
  finish(e.stack || e.message);
}
