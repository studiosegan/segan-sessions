// Task 1: prove the SERVER pipeline (chunk -> .part on disk -> finalize -> manifest),
// with NO browser. Slices a known-good fragmented MP4 into ordered byte-chunks, replays
// them through /api/rec/*, and asserts a valid faststart MP4 + manifest entry. Runs the
// real server against a throwaway library (SEGAN_LIBRARY + SEGAN_DATA) so real footage is untouched.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '..');
const serverJs = path.join(repoRoot, 'server.js');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'segan-rec-'));
const ART = path.join(dir, '.artifacts');
fs.mkdirSync(ART, { recursive: true });

function die(msg) { console.error('FAIL:', msg); cleanup(); process.exit(1); }
let child;
function cleanup() {
  try { child?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}

// 1) known-good fragmented MP4 (mimics MediaRecorder fMP4 output)
const src = path.join(ART, 'src.mp4');
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:d=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof', src,
], { stdio: 'ignore' });
const bytes = fs.readFileSync(src);

// 2) boot the server against a throwaway repo root
child = spawn(process.execPath, [serverJs], {
  env: { ...process.env, SEGAN_LIBRARY: tmpRoot, SEGAN_DATA: path.join(tmpRoot, '.data'), PORT: '4389' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`  [srv] ${d}`));

const base = await new Promise((resolve) => {
  const t = setTimeout(() => die('server did not start within 8s'), 8000);
  child.stdout.on('data', (d) => {
    const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
  });
});

// tiny fetch helper (Node built-in fetch)
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', body });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};

// 3) start -> chunk (in order) -> finish
const meta = encodeURIComponent(JSON.stringify({ mode: 'screen', ratio: '16:9', mime: 'video/mp4', device: 'self-test' }));
const started = await post(`${base}/api/rec/start?meta=${meta}`);
if (started.status !== 200 || !started.json.id) die(`rec/start -> ${started.status} ${JSON.stringify(started.json)}`);
const id = started.json.id;

const N = 8, step = Math.ceil(bytes.length / N);
for (let i = 0; i < bytes.length; i += step) {
  const chunk = bytes.subarray(i, Math.min(i + step, bytes.length));
  const r = await post(`${base}/api/rec/chunk?id=${id}`, chunk);
  if (r.status !== 200) die(`rec/chunk -> ${r.status} ${JSON.stringify(r.json)}`);
}
const fin = await post(`${base}/api/rec/finish?id=${id}`);
if (fin.status !== 201) die(`rec/finish -> ${fin.status} ${JSON.stringify(fin.json)}`);
const take = fin.json;

// 4) assertions
if (take.status !== 'raw') die(`take.status=${take.status} notes=${take.notes}`);
const outFile = path.join(tmpRoot, take.file);
if (!fs.existsSync(outFile)) die(`take file missing on disk: ${take.file}`);
if (fs.statSync(outFile).size < 1000) die(`take file too small (${fs.statSync(outFile).size} bytes)`);

const probe = execFileSync('ffprobe', [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name', '-show_entries', 'format=duration',
  '-of', 'default=nw=1', outFile,
], { encoding: 'utf8' });
const codec = (probe.match(/codec_name=(\w+)/) || [])[1];
const dur = parseFloat((probe.match(/duration=([\d.]+)/) || [])[1] || '0');
if (codec !== 'h264') die(`expected h264, got ${codec}`);
if (!(dur > 1)) die(`expected duration>1s, got ${dur}`);

// faststart: moov must appear before mdat in the remuxed file
const head = fs.readFileSync(outFile).subarray(0, 4096);
const moov = head.indexOf(Buffer.from('moov')), mdat = head.indexOf(Buffer.from('mdat'));
if (moov === -1 || (mdat !== -1 && moov > mdat)) die(`not faststart (moov@${moov} mdat@${mdat})`);

// manifest updated
const man = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'takes.json'), 'utf8'));
const list = Array.isArray(man) ? man : man.takes || [];
if (!list.some((t) => t.id === take.id)) die('take not found in manifest');

// finish no-op: already 16:9 h264 faststart → must NOT write a duplicate -fin file
const finRes = await post(`${base}/api/takes/${take.id}/finish`);
if (finRes.status !== 200) die(`finish -> ${finRes.status} ${JSON.stringify(finRes.json)}`);
if (fs.existsSync(outFile.replace(/\.mp4$/, '-fin.mp4'))) die('finish created a duplicate -fin file (double-save not fixed)');
if (finRes.json.status !== 'finished' || finRes.json.finished_file !== take.file) {
  die(`finish should mark finished in place, got ${JSON.stringify({ status: finRes.json.status, finished_file: finRes.json.finished_file })}`);
}

// clear-all: DELETE /api/takes removes files + empties the manifest
const del = await fetch(`${base}/api/takes`, { method: 'DELETE' });
const delBody = await del.json().catch(() => ({}));
if (del.status !== 200 || !delBody.cleared) die(`clear-all -> ${del.status} ${JSON.stringify(delBody)}`);
if (fs.existsSync(outFile)) die('clear-all did not delete the take file');
const man2 = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'takes.json'), 'utf8'));
if ((Array.isArray(man2) ? man2 : man2.takes || []).length !== 0) die('manifest not empty after clear-all');

console.log(`PASS: pipeline (${codec} ${dur}s, faststart, manifest) + finish-noop (no duplicate) + clear-all (${delBody.cleared} removed) ok`);
cleanup();
process.exit(0);
