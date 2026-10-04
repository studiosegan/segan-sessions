// config.json can move the footage into a project's own layout — custom folder names and a custom
// takes list — and the takes already in that list must keep showing. Builds such a project in a
// throwaway dir (one old take already listed), records a take through the real server, and checks
// where it landed. Also checks that SEGAN_LIBRARY still beats the config (the tests rely on that).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const dir = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(dir, '..', 'server.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segan-cfg-'));
const children = [];
function cleanup() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
function die(msg) { console.log(`FAIL: ${msg}`); cleanup(); process.exit(1); }

function boot(env, port) {
  const clean = { ...process.env };
  delete clean.SEGAN_LIBRARY;
  delete clean.SEGAN_CONFIG;
  const child = spawn(process.execPath, [serverJs], { env: { ...clean, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stderr.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
  return new Promise((resolve) => {
    const t = setTimeout(() => die('server did not start within 8s'), 8000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
    });
  });
}
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', body });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

// a project with its own layout, and a takes list that already holds one take
const project = path.join(tmp, 'project');
const oldTake = { id: 'old-1', file: 'assets/screen-recordings/old.mp4', mode: 'screen', ratio: '16:9', status: 'raw' };
fs.mkdirSync(path.join(project, 'assets'), { recursive: true });
fs.writeFileSync(path.join(project, 'assets', 'footage-manifest.json'), JSON.stringify({ version: 1, takes: [oldTake] }));
const configFile = path.join(tmp, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({
  library: project,
  folders: { camera: 'assets/camera', screen: 'assets/screen-recordings', phone: 'assets/phone', images: 'assets/images', scripts: path.join(tmp, 'scripts') },
  takes: 'assets/footage-manifest.json',
}));

const base = await boot({ SEGAN_CONFIG: configFile, SEGAN_DATA: path.join(tmp, 'data') }, 4388);
const listed = await (await fetch(`${base}/api/manifest`)).json();
if (!listed.takes.some((t) => t.id === 'old-1')) die('the take already in the custom takes list is not listed');

// record one streamed take
const src = path.join(tmp, 'src.mp4');
execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof', src], { stdio: 'ignore' });
const meta = encodeURIComponent(JSON.stringify({ mode: 'screen', ratio: '16:9', mime: 'video/mp4', device: 'self-test' }));
const started = await post(`${base}/api/rec/start?meta=${meta}`);
if (started.status !== 200) die(`rec/start -> ${started.status} ${JSON.stringify(started.json)}`);
const chunk = await post(`${base}/api/rec/chunk?id=${started.json.id}`, fs.readFileSync(src));
if (chunk.status !== 200) die(`rec/chunk -> ${chunk.status}`);
const fin = await post(`${base}/api/rec/finish?id=${started.json.id}`);
if (fin.status !== 201) die(`rec/finish -> ${fin.status} ${JSON.stringify(fin.json)}`);

const take = fin.json;
if (!take.file.startsWith('assets/screen-recordings/')) die(`take saved as "${take.file}", expected assets/screen-recordings/…`);
if (!fs.existsSync(path.join(project, take.file))) die(`take file missing at ${take.file}`);
const saved = JSON.parse(fs.readFileSync(path.join(project, 'assets', 'footage-manifest.json'), 'utf8'));
if (saved.takes.length !== 2) die(`custom takes list holds ${saved.takes.length} takes, expected 2`);
for (const stray of ['takes.json', 'Camera', 'Screen', 'Phone', 'Images']) {
  if (fs.existsSync(path.join(project, stray))) die(`default "${stray}" was created despite the config`);
}
if (!fs.existsSync(path.join(tmp, 'scripts'))) die('the absolute scripts folder from the config was not used');

// SEGAN_LIBRARY beats the config — default layout, in that folder
const plain = path.join(tmp, 'plain');
const base2 = await boot({ SEGAN_CONFIG: configFile, SEGAN_LIBRARY: plain, SEGAN_DATA: path.join(tmp, 'data2') }, 4387);
const health = await (await fetch(`${base2}/api/health`)).json();
if (health.library !== plain) die(`with SEGAN_LIBRARY set, library is ${health.library}`);
if (!fs.existsSync(path.join(plain, 'takes.json')) || !fs.existsSync(path.join(plain, 'Screen'))) die('SEGAN_LIBRARY did not get the default layout');

console.log(`PASS: custom layout — old take listed, new take → ${take.file.split('/').slice(0, 2).join('/')}/, one takes list; SEGAN_LIBRARY still wins`);
cleanup();
process.exit(0);
