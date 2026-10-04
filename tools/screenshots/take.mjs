#!/usr/bin/env node
// Regenerates the README images from the real app — a throwaway library, Chrome's fake camera fed
// the app icon (no real face in a public README), and a mock code editor as the shared "screen".
//   node tools/screenshots/take.mjs   →  docs/images/screener.jpg, docs/images/backgrounds.jpg
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { mktmp, bootServer } from '../../test/_util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });
const tmp = mktmp();

// Chrome loops a .y4m as its fake camera: the app icon, centred on the app's dark surface.
const y4m = path.join(tmp, 'camera.y4m');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x101119:s=1280x720:r=30',
  '-i', path.join(ROOT, 'launcher', 'app-icon.png'), '-filter_complex',
  '[1]scale=600:600[i];[0][i]overlay=(W-w)/2:(H-h)/2,format=yuv420p', '-t', '1', y4m]);

const CODE = `<span class="c">// record.js — every chunk goes straight to disk, so a crash never costs the take</span>
<span class="k">export async function</span> <span class="f">record</span>(stream, { ratio = <span class="s">'9:16'</span> } = {}) {
  <span class="k">const</span> recorder = <span class="k">new</span> <span class="f">MediaRecorder</span>(stream, {
    mimeType: <span class="s">'video/mp4;codecs=avc1'</span>,
    videoBitsPerSecond: <span class="n">12_000_000</span>,
  });
  <span class="k">const</span> take = <span class="k">await</span> <span class="f">startTake</span>({ ratio });
  recorder.ondataavailable = (e) => take.<span class="f">write</span>(e.data);
  recorder.<span class="f">start</span>(<span class="n">1000</span>);

  <span class="k">return async</span> () => {
    recorder.<span class="f">stop</span>();
    <span class="k">return</span> take.<span class="f">finish</span>(); <span class="c">// → a clean, faststart MP4</span>
  };
}`;
const EDITOR = `<!doctype html><html><body style="margin:0;width:1600px;height:1000px;display:flex;background:#0d1117;
  font:21px/1.75 ui-monospace,'SF Mono',Menlo,monospace;color:#c9d1d9">
<style>.k{color:#ff7b72}.s{color:#a5d6ff}.f{color:#d2a8ff}.n{color:#79c0ff}.c{color:#8b949e;font-style:italic}
aside div{padding:5px 12px;border-radius:6px}</style>
<aside style="width:300px;background:#0a0d12;border-right:1px solid #1d2330;padding:22px 14px;font:16px system-ui;color:#7d8590">
  <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase">Explorer</div>
  <div>▾ my-reel-tool</div><div style="padding-left:30px">lib</div><div style="padding-left:30px">public</div>
  <div style="padding-left:30px;background:#1a2130;color:#e6edf3">record.js</div>
  <div style="padding-left:30px">server.js</div><div style="padding-left:30px">package.json</div>
</aside>
<main style="flex:1;display:flex;flex-direction:column">
  <div style="height:56px;display:flex;align-items:end;background:#0a0d12;border-bottom:1px solid #1d2330">
    <div style="padding:14px 26px;background:#0d1117;border-top:2px solid #246cf8;font:16px system-ui;color:#e6edf3">record.js</div>
    <div style="padding:14px 26px;font:16px system-ui;color:#7d8590">server.js</div>
  </div>
  <pre style="margin:0;padding:34px 40px;font:inherit;white-space:pre">${CODE}</pre>
</main></body></html>`;

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required'],
});
let child;
try {
  // the shared "screen", rendered once
  const shot = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await shot.setContent(EDITOR);
  const editor = `data:image/png;base64,${(await shot.screenshot()).toString('base64')}`;
  await shot.close();

  const boot = await bootServer(tmp); child = boot.child;
  const context = await browser.newContext({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
  await context.addInitScript((src) => {
    Object.assign(localStorage, {
      'ss-mode': 'composite', 'ss-theme': 'dark', 'ss-ratio': '9:16', 'ss-countdown': '0', 'ss-hints': 'off',
      'ss-composite-v2': JSON.stringify({
        bubble: { xF: 0.5, yF: 0.8, wF: 0.34, hF: 0.34, shape: 'circle', borderW: 5, borderColor: '#ffffff', radius: 16 },
        fit: 'contain', grid: false, winRad: 26,
      }),
    });
    navigator.mediaDevices.getDisplayMedia = async () => {
      const img = new Image(); img.src = src; await img.decode();
      const cv = document.createElement('canvas'); cv.width = 1600; cv.height = 1000;
      const g = cv.getContext('2d');
      setInterval(() => g.drawImage(img, 0, 0), 33);
      return cv.captureStream(30);
    };
  }, editor);
  const page = await context.newPage();
  await page.goto(boot.base);
  await page.waitForFunction(() => typeof document.getElementById('btn-pick-screen').onclick === 'function');
  await page.click('#btn-pick-screen');
  await page.$eval('#rng-zoom', (el) => { el.value = '92'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(800);
  // a tutorial needs no call audio — and Chrome's fake mic shouldn't be named in a README
  await page.click('#btn-call-audio-ok').catch(() => {});
  await page.$$eval('#sel-mic option', (os) => os.forEach((o) => { o.textContent = 'Built-in Microphone'; }));
  await page.waitForTimeout(1700); // zoom eases in; camera + backdrop settle
  const png = path.join(tmp, 'screener.png');
  await page.screenshot({ path: png });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '3', path.join(OUT, 'screener.jpg')]);

  // the background set, six across
  const sheet = await browser.newPage({ viewport: { width: 1720, height: 600 } });
  await sheet.goto(`file://${path.join(ROOT, 'tools', 'backgrounds', 'backgrounds.html')}?preview`);
  const spng = path.join(tmp, 'backgrounds.png');
  await sheet.screenshot({ path: spng, fullPage: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', spng, '-q:v', '3', path.join(OUT, 'backgrounds.jpg')]);
  console.log(`→ ${path.relative(ROOT, OUT)}/screener.jpg, backgrounds.jpg`);
} finally {
  await browser.close();
  child?.kill();
}
