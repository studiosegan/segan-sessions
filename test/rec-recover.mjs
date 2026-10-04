// Task 5: crash recovery. Plant an orphan <file>.part (as a crash would leave), boot the
// server, and assert it gets finalized into a recovered take + the .part is cleaned up.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mktmp, bootServer } from './_util.mjs';

const tmp = mktmp();
let child;
function done(ok, msg) {
  try { child?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'}: ${msg}`);
  process.exit(ok ? 0 : 1);
}

// plant an orphan .part (a valid fragmented MP4, as a crash mid-record would leave)
const dir = path.join(tmp, 'Screen');
fs.mkdirSync(dir, { recursive: true });
const part = path.join(dir, '20260731-000000-abcd-screen-16x9.mp4.part');
execFileSync('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:d=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', part,
], { stdio: 'ignore' });

try {
  const boot = await bootServer(tmp); child = boot.child; const base = boot.base;
  // boot recovery runs async — poll the manifest for the recovered take
  const deadline = Date.now() + 8000;
  let take = null;
  while (Date.now() < deadline && !take) {
    const man = await fetch(base + '/api/manifest').then((r) => r.json()).catch(() => null);
    const list = Array.isArray(man) ? man : (man?.takes || []);
    take = list.find((t) => (t.notes || '').includes('recovered'));
    if (!take) await new Promise((r) => setTimeout(r, 300));
  }
  if (!take) done(false, 'no recovered take appeared in the manifest');
  if (fs.existsSync(part)) done(false, '.part was not cleaned up after recovery');
  if (!fs.existsSync(path.join(tmp, take.file))) done(false, `recovered file missing: ${take.file}`);
  if (take.status !== 'raw') done(false, `recovered take status=${take.status} notes=${take.notes}`);
  done(true, `crash-orphaned .part recovered → ${take.file} (status ${take.status})`);
} catch (e) { done(false, e.stack || e.message); }
