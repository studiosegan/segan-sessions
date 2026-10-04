// Shared helpers for the dev-only self-tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

export const testDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(testDir, '..');

export function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'segan-rec-')); }

// Boot the real server against a throwaway library + data dir (never your real footage), on the same
// node that runs the tests; resolve once it prints its URL.
export function bootServer(tmpRoot, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'server.js')], {
    env: { ...process.env, SEGAN_LIBRARY: tmpRoot, SEGAN_DATA: path.join(tmpRoot, '.data'), PORT: '4390', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`  [srv] ${d}`));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start in 8s')), 8000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(t); resolve({ base: `http://127.0.0.1:${m[1]}`, child }); }
    });
  });
}

export function probe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate',
    '-show_entries', 'format=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
  const [n, d] = (v.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    codec: v.codec_name,
    acodec: a.codec_name || null,
    fps: d ? +(n / d).toFixed(1) : 0,
    dur: parseFloat(j.format?.duration || '0'),
  };
}

export const VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'vp09', 'av1', 'av01'];
