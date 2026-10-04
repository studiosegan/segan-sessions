// Task 2 (+3/+4): drive the REAL StreamingRecorder in a real headless browser through the
// real server — the exact client path that produced 0-byte files before. Uses a fake camera
// as the stream source (getDisplayMedia can't be faked headless); `--mode=` only tags the
// take, since the streaming TRANSPORT is identical for camera and screen. Occlusion/duration
// on the real capture source is the final manual test.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { mktmp, bootServer, probe, VIDEO_CODECS } from './_util.mjs';

const mode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=screen').split('=')[1];
const secs = Number((process.argv.find((a) => a.startsWith('--secs=')) || '--secs=4').split('=')[1]);

const tmp = mktmp();
let child, browser;
function done(ok, msg) {
  try { child?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (ok) { console.log('PASS:', msg); process.exit(0); }
  console.error('FAIL:', msg); process.exit(1);
}

try {
  const boot = await bootServer(tmp); child = boot.child; const base = boot.base;
  browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('  [page]', m.text()));
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // Serve a minimal page ON THE SERVER ORIGIN so `import('/js/recorder.js')` resolves to the real app.
  await page.route('**/__rectest__', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>rectest</title>' }));
  await page.goto(base + '/__rectest__');

  const res = await page.evaluate(async ({ mode, secs }) => {
    const { StreamingRecorder } = await import('/js/recorder.js');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360, frameRate: 30 }, audio: true });
    const rec = new StreamingRecorder(stream, { bitrate: 4_000_000, meta: { mode, ratio: '16:9', device: 'self-test' } });
    await rec.start();
    await new Promise((r) => setTimeout(r, secs * 1000));
    const take = await rec.stop();
    stream.getTracks().forEach((t) => t.stop());
    return { take, sent: rec.sent, mime: rec.mimeType };
  }, { mode, secs });

  await browser.close(); browser = null;

  const t = res?.take;
  if (!t) done(false, 'no take returned');
  if (t.status !== 'raw') done(false, `take.status=${t.status} notes=${t.notes || ''}`);
  const f = path.join(tmp, t.file);
  if (!fs.existsSync(f)) done(false, `take file missing on disk: ${t.file}`);
  const { codec, dur, acodec, fps } = probe(f);
  if (!VIDEO_CODECS.includes(codec)) done(false, `unexpected codec ${codec}`);
  if (!(dur > 1)) done(false, `duration ${dur}s (expected > 1)`);
  if (acodec && acodec !== 'aac') done(false, `audio should be AAC after finalize, got ${acodec}`);
  if (!(res.sent >= 2)) done(false, `only ${res.sent} chunk(s) streamed (expected ≥2)`);
  done(true, `mode=${mode} streamed ${res.sent} chunks → ${codec}/${acodec || 'no-audio'} ${dur.toFixed(1)}s @${fps}fps, status raw, on disk + manifest`);
} catch (e) {
  try { await browser?.close(); } catch {}
  done(false, e.stack || e.message);
}
