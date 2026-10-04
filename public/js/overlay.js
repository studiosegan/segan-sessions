// overlay.js — crop guides + brand safe zones drawn over the live preview.
// Everything outside the crop is dimmed; what glows in the middle IS the reel.

export const RATIOS = {
  '9:16': { a: 9, b: 16, out: '1080×1920' },
  '4:5': { a: 4, b: 5, out: '1080×1350' },
  '1:1': { a: 1, b: 1, out: '1080×1080' },
  '16:9': { a: 16, b: 9, out: '1920×1080' },
};

// Brand kit (brand/visual-kit.md): keep text out of top 220px / bottom 320px of the output frame.

// Compute the rect the <video> content occupies inside its box (object-fit: contain).
export function contentRect(boxW, boxH, srcW, srcH) {
  if (!srcW || !srcH) return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * scale, h = srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// Center crop of ratio a:b inside a content rect.
export function cropRect(rect, a, b) {
  const target = a / b;
  const current = rect.w / rect.h;
  let w = rect.w, h = rect.h;
  if (current > target) w = rect.h * target; else h = rect.w / target;
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

export function drawOverlay(canvas, video, ratioKey, { safeZones = true } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const boxW = canvas.clientWidth, boxH = canvas.clientHeight;
  if (canvas.width !== boxW * dpr || canvas.height !== boxH * dpr) {
    canvas.width = boxW * dpr; canvas.height = boxH * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, boxW, boxH);

  const r = RATIOS[ratioKey] || RATIOS['9:16'];
  const content = contentRect(boxW, boxH, video.videoWidth, video.videoHeight);
  const crop = cropRect(content, r.a, r.b);

  // scrim outside the crop
  ctx.fillStyle = 'rgba(5,6,8,0.72)';
  ctx.beginPath();
  ctx.rect(0, 0, boxW, boxH);
  ctx.rect(crop.x, crop.y, crop.w, crop.h);
  ctx.fill('evenodd');

  // crop border
  ctx.strokeStyle = '#246cf8';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(crop.x + 0.75, crop.y + 0.75, crop.w - 1.5, crop.h - 1.5);

  // safe zones (portrait ratios only — they encode reel UI chrome).
  // Brand values are pixels of the output frame: top 220 / bottom 320.
  if (safeZones && (ratioKey === '9:16' || ratioKey === '4:5')) {
    const outH = ratioKey === '9:16' ? 1920 : 1350;
    const safeTopPx = crop.y + crop.h * (220 / outH);
    const safeBottomPx = crop.y + crop.h * (1 - 320 / outH);
    ctx.strokeStyle = 'rgba(154,161,173,0.55)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(crop.x, safeTopPx); ctx.lineTo(crop.x + crop.w, safeTopPx);
    ctx.moveTo(crop.x, safeBottomPx); ctx.lineTo(crop.x + crop.w, safeBottomPx);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(154,161,173,0.75)';
    ctx.font = '500 10px ui-monospace, Menlo, monospace';
    ctx.fillText('keep text below', crop.x + 8, safeTopPx - 5);
    ctx.fillText('keep text above', crop.x + 8, safeBottomPx + 13);
  }

  // output size badge
  ctx.fillStyle = 'rgba(5,6,8,0.8)';
  const badge = r.out;
  ctx.font = '500 11px ui-monospace, Menlo, monospace';
  const tw = ctx.measureText(badge).width;
  ctx.fillRect(crop.x + crop.w - tw - 18, crop.y + crop.h - 24, tw + 14, 18);
  ctx.fillStyle = '#9aa1ad';
  ctx.fillText(badge, crop.x + crop.w - tw - 11, crop.y + crop.h - 11);
}
