// A browser that dies mid-recording must not cost the take. Chrome can kill a tab for memory an
// hour into a meeting; the footage survives as a .part, but it used to sit invisible because
// crash recovery only ran when the SERVER restarted. Now the server notices the silence and
// finalizes the take on its own. The two things that must NEVER be mistaken for a crash are a
// paused take (no chunks, but the page still pings) and the Mac sleeping (server and page frozen).
// Runs the real app against a 4 s orphan timeout (production: 120 s) so it takes seconds.
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
  try { child?.kill('SIGCONT'); child?.kill('SIGKILL'); } catch {}
  try { browser?.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.ok).length;
  if (crash) { console.error(`FAIL: crashed after ${results.length} checks — ${crash}`); process.exit(1); }
  if (bad) { console.error(`FAIL: ${bad} of ${results.length} auto-recovery checks failed`); process.exit(1); }
  console.log(`PASS: crashed take saves itself; pause + Mac sleep never mistaken for a crash — ${results.length} checks`);
  process.exit(0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 200) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v || Date.now() - t0 > ms) return v; await sleep(step); }
}
function decodeErrors(file) {
  const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return (r.stderr || '').split('\n').filter((l) => l.trim() && !/non monotonically increasing dts/.test(l)).length;
}

try {
  const boot = await bootServer(tmp, { SEGAN_ORPHAN_MS: '4000' }); child = boot.child; const base = boot.base;
  // A known profile dir, so every Chrome process of this run (browser, GPU, renderer) can be found
  // and frozen together with the server — that is what a Mac sleep does.
  const profile = path.join(tmp, 'chrome-profile');
  const context = await chromium.launchPersistentContext(profile, {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 },
  });
  browser = context;
  // The main Chrome process carries the profile path; its renderer/GPU/network helpers are its
  // CHILDREN and don't — so collect the whole tree, or the page keeps running through the "sleep".
  const pgrep = (...a) => spawnSync('pgrep', a, { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
  const chromePids = () => {
    const all = new Set(pgrep('-f', profile));
    for (let grew = true; grew;) { grew = false; for (const p of [...all]) for (const c of pgrep('-P', String(p))) if (!all.has(c)) { all.add(c); grew = true; } }
    return [...all];
  };
  const signalAll = (sig) => { for (const pid of [child.pid, ...chromePids()]) { try { process.kill(pid, sig); } catch {} } };
  await context.addInitScript(() => {
    localStorage.setItem('ss-mode', 'composite');
    localStorage.setItem('ss-countdown', '0');
    navigator.mediaDevices.getDisplayMedia = async () => {
      const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
      const g = cv.getContext('2d'); let n = 0;
      setInterval(() => { g.fillStyle = `hsl(${(n++ * 7) % 360} 60% 40%)`; g.fillRect(0, 0, 1280, 720); }, 33);
      return cv.captureStream(30);
    };
  });
  const page = await context.newPage();
  let chunks = 0;
  const logs = []; // captured here, never written to a real segan-session.log
  await page.route('**/api/log', async (r) => {
    try { logs.push(JSON.parse(r.request().postData() || '{}')); } catch {}
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.route('**/api/screener/backdrop', (r) => r.fulfill({ status: 404, body: '' }));
  await page.route('**/api/rec/chunk*', (r) => { chunks++; return r.continue(); });

  const takes = async () => (await (await fetch(`${base}/api/manifest`)).json()).takes;
  const isRecording = () => page.evaluate(() => document.getElementById('btn-record').classList.contains('recording'));

  await page.goto(`${base}/`);
  await waitFor(() => page.evaluate(() => typeof document.getElementById('btn-pick-screen').onclick === 'function'));
  await page.uncheck('#chk-autofinish-comp');
  await page.click('#btn-pick-screen');
  await waitFor(() => page.evaluate(() => !document.getElementById('btn-record').disabled));
  await page.selectOption('#sel-bubble-shape', 'off');

  // ---- a PAUSED take (no chunks for > the timeout) stays one live take ----
  let before = (await takes()).length;
  await page.click('#btn-record'); await waitFor(isRecording);
  await sleep(2000);
  await page.click('#btn-pause');
  await sleep(7000); // longer than the 4 s timeout — only the ping keeps it alive
  await page.click('#btn-pause');
  await sleep(2000);
  await page.click('#btn-record');
  await waitFor(async () => (await takes()).length > before, 20000);
  await sleep(5000); // give the watchdog every chance to (wrongly) split it
  let now = await takes();
  const paused = now.slice(before);
  check('a take paused longer than the timeout saves as ONE normal take', paused.length === 1, `${paused.length} take(s)`);
  check('…and is not marked as a crash', paused[0] && !/recovered/.test(paused[0].notes || ''), paused[0]?.notes);
  check('…with the pause cut out (≈4 s, not 11 s)', paused[0] && paused[0].duration > 3 && paused[0].duration < 6.5, `${paused[0]?.duration} s`);

  const health = logs.filter((l) => l.context === 'rec-health');
  check('each recording leaves a health line (memory + upload backlog) in the log',
    health.length >= 1 && health.every((h) => Number.isFinite(h.heapMB) && Number.isFinite(h.queued) && Number.isFinite(h.sec)),
    JSON.stringify(health[0] || {}));

  // ---- the Mac sleeping (server AND Chrome frozen 7 s) is not a crash either ----
  // Freezing only the server is not a sleep: the page's pings would queue up and be delivered the
  // moment it wakes, keeping the take alive without the sleep guard ever being tested.
  before = now.length;
  await page.click('#btn-record'); await waitFor(isRecording);
  await sleep(2000);
  const frozen = chromePids().length;
  signalAll('SIGSTOP');
  await sleep(7000);
  signalAll('SIGCONT');
  await sleep(3000);
  await page.click('#btn-record');
  await waitFor(async () => (await takes()).length > before, 20000);
  await sleep(5000);
  now = await takes();
  const slept = now.slice(before);
  check('a "Mac sleep" mid-take saves as ONE normal take', slept.length === 1 && !/recovered/.test(slept[0]?.notes || ''),
    `${slept.map((t) => t.notes || 'normal').join(', ') || 'no take'} (froze the server + ${frozen} Chrome processes)`);

  // ---- the tab CRASHES mid-take: the take saves itself, no server restart ----
  before = now.length;
  chunks = 0;
  await page.click('#btn-record'); await waitFor(isRecording);
  await waitFor(async () => chunks >= 2, 30000, 250); // some footage must be on disk first
  const onDisk = chunks;
  const cdp = await context.newCDPSession(page);
  cdp.send('Page.crash').catch(() => {}); // the renderer dies, like an out-of-memory kill
  const t0 = Date.now();
  const recovered = await waitFor(async () => (await takes()).slice(before).find((t) => /recovered from crash/.test(t.notes || '')), 20000, 250);
  check('a crashed tab\'s take appears in Takes on its own (no restart)', !!recovered,
    recovered ? `after ${((Date.now() - t0) / 1000).toFixed(1)} s, ${onDisk} chunks were on disk` : 'never appeared');
  const f = recovered ? path.join(tmp, recovered.file) : null;
  const p = f && fs.existsSync(f) ? probe(f) : {};
  check('…the recovered file has video and audio', p.codec && p.acodec === 'aac', `${p.codec}/${p.acodec}`);
  check('…and decodes cleanly', f && decodeErrors(f) === 0);
  check('…with no .part left behind', !fs.readdirSync(path.join(tmp, 'Screen')).some((x) => x.endsWith('.part')));

  const errors = logs.filter((l) => l.level === 'error' && !/MediaRecorder\.onerror/.test(l.context || ''));
  check('no unexpected errors logged by the page', errors.length === 0, errors.map((e) => e.context).join(', '));

  finish();
} catch (e) {
  finish(e.stack || e.message);
}
