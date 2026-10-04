// Task 0 GATE: prove Playwright can record headless in THIS environment.
// Serves the harness on localhost (secure context for getUserMedia), records ~5s with
// a fake camera/mic, writes the file, and probes it. Refutes the "0-byte file" failure.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(dir, '.artifacts');
fs.mkdirSync(ART, { recursive: true });
const harness = fs.readFileSync(path.join(dir, 'fixtures', 'harness.html'), 'utf8');

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(harness);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone', 'camera'] });
const page = await ctx.newPage();
page.on('console', (m) => console.log('  [page]', m.text()));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

let result;
try {
  await page.goto(`http://127.0.0.1:${port}/`);
  result = await page.evaluate(async () => window.run(5000));
} finally {
  await browser.close();
  server.close();
}

if (!result || !result.size) {
  console.error('FAIL: recorded 0 bytes (the exact failure we are guarding against)');
  process.exit(1);
}
const out = path.join(ART, result.mime.includes('mp4') ? 'smoke.mp4' : 'smoke.webm');
fs.writeFileSync(out, Buffer.from(result.b64, 'base64'));
console.log(`recorded ${result.size} bytes (${result.mime}) -> ${path.relative(process.cwd(), out)}`);

const probe = execFileSync('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name,width,height',
  '-of', 'default=nw=1', out,
], { encoding: 'utf8' }).trim();
console.log(probe.replace(/\n/g, '  '));

const codec = (probe.match(/codec_name=([\w]+)/) || [])[1];
const okCodec = ['h264', 'vp8', 'vp9', 'vp09', 'av1', 'av01'].includes(codec);
if (okCodec && result.size > 10000) {
  console.log(`PASS: real ${codec} video recorded headless (${result.size} bytes)`);
  process.exit(0);
}
console.error(`FAIL: codec=${codec} size=${result.size}`);
process.exit(1);
