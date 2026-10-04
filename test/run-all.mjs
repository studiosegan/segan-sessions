// Run every recording self-test and print one green/red board. Run before every handoff:
//   npm test        (or: node test/run-all.mjs)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = [
  ['rec-smoke.mjs', []],
  ['server-rec.mjs', []],
  ['rec-streaming.mjs', ['--mode=screen']],
  ['rec-streaming.mjs', ['--mode=camera']],
  ['rec-recover.mjs', []],
  ['rec-disk.mjs', []],
  ['screener-audio.mjs', []], // drives the real Screener UI: mic, camera off, mute, call audio, codec race
  ['rec-autorecover.mjs', []], // a crashed tab's take saves itself; pause + Mac sleep are not crashes
  ['config-layout.mjs', []],   // config.json: a project's own folders + takes list; SEGAN_LIBRARY still wins
];

let failed = 0;
for (const [file, args] of tests) {
  const label = `${file} ${args.join(' ')}`.trim();
  // the same node that runs this board — so the suite also passes on the installer's private runtime
  const r = spawnSync(process.execPath, [path.join(dir, file), ...args], { encoding: 'utf8' });
  const line = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(Boolean).reverse().find((l) => /^(PASS|FAIL)/.test(l))
    || (r.error ? `could not start: ${r.error.message}` : 'no result');
  const ok = line.startsWith('PASS') && r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${label.padEnd(32)} ${line}`);
}
console.log(failed ? `\n${failed} test(s) FAILED` : '\nAll recording self-tests passed ✅');
process.exit(failed ? 1 : 0);
