// manifest.js — single writer for the takes manifest, <library>/takes.json (atomic tmp+rename, serialized).
import fs from 'node:fs';
import { isoNow } from './util.js';

let manifestPath = null;
let queue = Promise.resolve(); // serialize all writes in-process

export function init(file) {
  manifestPath = file;
  if (!fs.existsSync(manifestPath)) {
    writeAtomic({ version: 1, updated: isoNow(), takes: [] });
  }
  return manifestPath;
}

export function load() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function writeAtomic(data) {
  data.updated = isoNow();
  const tmp = manifestPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, manifestPath);
}

// all mutations go through this queue so concurrent requests can't interleave read-modify-write.
// the queue itself swallows rejections — one failed write must not poison every later mutation.
function mutate(fn) {
  const p = queue.then(() => {
    const data = load();
    const result = fn(data);
    writeAtomic(data);
    return result;
  });
  queue = p.catch(() => {});
  return p;
}

export function append(take) {
  return mutate((data) => { data.takes.push(take); return take; });
}

export function update(id, patch) {
  return mutate((data) => {
    const take = data.takes.find((t) => t.id === id);
    if (!take) return null;
    Object.assign(take, patch);
    return take;
  });
}

export function remove(id) {
  return mutate((data) => {
    const i = data.takes.findIndex((t) => t.id === id);
    if (i === -1) return null;
    return data.takes.splice(i, 1)[0];
  });
}

export function get(id) {
  return load().takes.find((t) => t.id === id) || null;
}

export function clear() {
  return mutate((data) => { const n = data.takes.length; data.takes = []; return n; });
}
