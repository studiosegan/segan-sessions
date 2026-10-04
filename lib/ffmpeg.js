// ffmpeg.js — probe + finish (crop/scale to reel ratio) + remux. Hardware encode via VideoToolbox.
import fs from 'node:fs';
import { run } from './util.js';

export const RATIOS = {
  '9:16': { w: 1080, h: 1920, a: 9, b: 16 },
  '1:1': { w: 1080, h: 1080, a: 1, b: 1 },
  '4:5': { w: 1080, h: 1350, a: 4, b: 5 },
  '16:9': { w: 1920, h: 1080, a: 16, b: 9 },
};

export async function probe(file) {
  const { code, stdout, stderr } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { timeoutMs: 30000 });
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(0, 300)}`);
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const fpsFrac = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
  let fps = null;
  if (fpsFrac) {
    const [n, d] = fpsFrac.split('/').map(Number);
    if (d) fps = Math.round((n / d) * 100) / 100;
  }
  return {
    width: v.width || null,
    height: v.height || null,
    fps,
    duration: info.format?.duration ? Math.round(Number(info.format.duration) * 10) / 10 : null,
    size_bytes: info.format?.size ? Number(info.format.size) : null,
    codec: v.codec_name || null,
    audio_codec: a ? a.codec_name : null,
    container: (info.format?.format_name || '').split(',')[0] || null,
    bit_rate: info.format?.bit_rate ? Number(info.format.bit_rate) : null,
  };
}

// Center-crop to A:B then scale to W×H. Works for any source geometry (even dims enforced).
function cropScaleFilter({ a, b, w, h }) {
  return `crop='trunc(min(iw,ih*${a}/${b})/2)*2':'trunc(min(ih,iw*${b}/${a})/2)*2',` +
    `scale=${w}:${h}:flags=lanczos,setsar=1`;
}

const ENCODE_ARGS = [
  '-c:v', 'h264_videotoolbox', '-b:v', '12M', '-maxrate', '14M', '-allow_sw', '1',
  '-pix_fmt', 'yuv420p', '-r', '30',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
];

// Is the MP4 already faststart (moov before mdat)? Then it needs no remux at all.
function isFaststart(file) {
  try {
    const len = Math.min(65536, fs.statSync(file).size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    const mo = buf.indexOf('moov'), md = buf.indexOf('mdat');
    return mo !== -1 && (md === -1 || mo < md);
  } catch { return false; }
}

// Finish a take: crop/scale to the target ratio, or fast-remux when nothing needs re-encoding.
// Returns { noop, probe }. noop=true means the raw is ALREADY the deliverable (right ratio,
// h264/aac MP4, faststart) — so the caller keeps the raw and skips writing a -fin duplicate.
export async function finish(inFile, outFile, ratio) {
  const target = RATIOS[ratio];
  if (!target) throw new Error(`unknown ratio: ${ratio}`);
  const src = await probe(inFile);

  const alreadyRatio = src.width && src.height &&
    Math.abs(src.width / src.height - target.a / target.b) < 0.01;
  const isMp4H264 = src.container === 'mov' || src.container === 'mp4'
    ? src.codec === 'h264' && (src.audio_codec === 'aac' || src.audio_codec == null)
    : false;
  const deliverable = alreadyRatio && isMp4H264 && src.width <= target.w;

  // Already a deliverable, faststart MP4 at the target ratio → finishing would only duplicate it.
  if (deliverable && isFaststart(inFile)) return { noop: true, probe: src };

  const args = deliverable
    ? ['-y', '-i', inFile, '-c', 'copy', '-movflags', '+faststart', outFile] // at ratio but not faststart → just add it
    : ['-y', '-i', inFile, '-vf', cropScaleFilter(target), ...ENCODE_ARGS, outFile];
  const { code, stderr } = await run('ffmpeg', args, { timeoutMs: 15 * 60 * 1000 });
  if (code !== 0) throw new Error(`ffmpeg finish failed: ${stderr.slice(-400)}`);
  return { noop: false, probe: await probe(outFile) };
}

// Container swap → faststart MP4. Default copies every stream losslessly (scrcpy mkv→mp4).
// audio:'aac' re-encodes ONLY the audio to AAC (video stays a lossless copy) — Chrome muxes
// Opus into its MP4, which QuickTime/Final Cut/Premiere won't play; AAC is universal.
export async function remuxToMp4(inFile, outFile, { audio = 'copy' } = {}) {
  const codecArgs = audio === 'aac'
    ? ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k']
    : ['-c', 'copy'];
  const { code, stderr } = await run('ffmpeg',
    ['-y', '-i', inFile, ...codecArgs, '-movflags', '+faststart', outFile],
    { timeoutMs: 10 * 60 * 1000 });
  if (code !== 0) throw new Error(`remux failed: ${stderr.slice(-400)}`);
  return probe(outFile);
}

export async function version() {
  try {
    const { code, stdout } = await run('ffmpeg', ['-version'], { timeoutMs: 5000 });
    return code === 0 ? stdout.split('\n')[0].replace('ffmpeg version ', '').split(' ')[0] : null;
  } catch { return null; }
}
