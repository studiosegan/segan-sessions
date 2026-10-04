// util.js — small shared helpers, no dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 20260714-183012 in local time (filenames sort chronologically)
export function nowStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function isoNow(d = new Date()) {
  // local ISO with offset, e.g. 2026-07-14T18:30:12+06:00
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

export function makeId(stamp = nowStamp()) {
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

// keep only filesystem-friendly characters
export function safeSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function readJsonBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// stream an incoming request body straight to disk (never buffer video in memory)
export function streamToFile(req, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    req.pipe(out);
    out.on('finish', () => resolve(fs.statSync(filePath).size));
    out.on('error', reject);
    req.on('error', reject);
  });
}

// run a command, capture output. resolves {code, stdout, stderr}; never rejects on non-zero exit.
export function run(cmd, args = [], { timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export async function which(cmd) {
  try {
    const { code, stdout } = await run('/usr/bin/which', [cmd]);
    return code === 0 ? stdout.trim() : null;
  } catch { return null; }
}

export async function diskFreeGB(dir) {
  const { code, stdout } = await run('/bin/df', ['-k', dir]);
  if (code !== 0) return null;
  const line = stdout.trim().split('\n').pop();
  const avail = Number(line.split(/\s+/)[3]); // 1K blocks available
  return Number.isFinite(avail) ? Math.round((avail / 1024 / 1024) * 10) / 10 : null;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function libRelative(root, abs) {
  return path.relative(root, abs);
}
