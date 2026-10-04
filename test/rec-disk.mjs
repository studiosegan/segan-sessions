// Task 6: disk guard. Force the free-space requirement impossibly high and assert recStart
// refuses with 507 instead of starting a doomed multi-hour recording.
import fs from 'node:fs';
import { mktmp, bootServer } from './_util.mjs';

const tmp = mktmp();
let child;
function done(ok, msg) {
  try { child?.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  console[ok ? 'log' : 'error'](`${ok ? 'PASS' : 'FAIL'}: ${msg}`);
  process.exit(ok ? 0 : 1);
}

try {
  process.env.SEGAN_MIN_FREE_GB = '9999999'; // inherited by the spawned server
  const boot = await bootServer(tmp); child = boot.child; const base = boot.base;
  const meta = encodeURIComponent(JSON.stringify({ mode: 'screen', ratio: '16:9', mime: 'video/mp4' }));
  const r = await fetch(`${base}/api/rec/start?meta=${meta}`, { method: 'POST' });
  if (r.status !== 507) done(false, `expected 507, got ${r.status}`);
  const body = await r.json().catch(() => ({}));
  if (!/free/i.test(body.error || '')) done(false, `unexpected error text: ${body.error}`);
  done(true, `disk guard blocks recording when space is low (507: "${body.error}")`);
} catch (e) { done(false, e.stack || e.message); }
