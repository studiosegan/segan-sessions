// composite.js — Mode 2: Loom-style screen + face bubble, composited live on a
// canvas at the exact output size, so what you see is exactly what's encoded.
//
// Region selection = pan & zoom INSIDE the output frame only (drag to move,
// scroll to zoom — pointer events outside the frame are ignored). The bubble
// is a free rectangle: drag to move (snaps to center/margins), corner handle
// to stretch it over more area, scroll to scale, radius/border configurable.
// A Lock freezes ratio + view + bubble so nothing reacts to stray scrolls.
// Privacy blurs are drawn in SCREEN coordinates, so they stick to the content
// through pan/zoom.
import { makeRecorder, openCameraVideo, openMic, listDevices, fillDeviceSelect } from './recorder.js';
import { logError, logEvent } from './log.js';
import { createCallMeter } from './meter.js';
import { uploadRecording, finishTake, screenerBackdropSave } from './api.js';

const CANVAS_SIZE = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1920, 1080] };
const STORE_KEY = 'ss-composite-v2';
const MARGIN = 36;      // canvas px at 1080-wide reference (presets + snapping)
const HANDLE_R = 16;    // hit half-size of each resize handle, canvas px (smaller = more precise)
const MAX_ZOOM = 12;    // enough to feature one chat window from a big monitor
const MIN_ZOOM = 0.35;  // below 1.0 the window shrinks inside the frame → floats on a backdrop

export function createCompositeMode(ctx) {
  const els = {
    canvas: document.getElementById('composite-canvas'),
    wrap: document.getElementById('canvas-wrap'),
    grid: document.getElementById('canvas-grid'),
    gridBtn: document.getElementById('btn-grid'),
    stageBox: document.getElementById('stage-box'),
    preview: document.getElementById('preview'),
    pick: document.getElementById('btn-pick-screen'),
    mainSource: document.getElementById('sel-main-source'),
    bubbleSource: document.getElementById('sel-bubble-source'),
    bubblePick: document.getElementById('btn-bubble-pick'),
    popout: document.getElementById('btn-popout'),
    fit: document.getElementById('sel-fit'),
    zoom: document.getElementById('rng-zoom'),
    winRadius: document.getElementById('rng-win-radius'),
    winRadiusVal: document.getElementById('win-radius-val'),
    viewReset: document.getElementById('btn-view-reset'),
    lock: document.getElementById('btn-lock'),
    lockIcons: { open: document.querySelector('#btn-lock .ic-unlocked'), closed: document.querySelector('#btn-lock .ic-locked') },
    ratio: document.getElementById('sel-ratio'),
    shape: document.getElementById('sel-bubble-shape'),
    pos: document.getElementById('sel-bubble-pos'),
    mic: document.getElementById('sel-mic'), // lives in the shared panel: visible in Screener too
    callWarn: document.getElementById('call-audio-warn'),
    repickAudio: document.getElementById('btn-repick-audio'),
    callOk: document.getElementById('btn-call-audio-ok'),
    size: document.getElementById('rng-bubble-size'),
    radius: document.getElementById('rng-bubble-radius'),
    borderW: document.getElementById('rng-bubble-border'),
    borderC: document.getElementById('clr-bubble-border'),
    bgGallery: document.getElementById('bg-gallery'),
    bgPick: document.getElementById('btn-bg-pick'),
    bgClear: document.getElementById('btn-bg-clear'),
    bgInput: document.getElementById('inp-bg'),
    blurAdd: document.getElementById('btn-blur-add'),
    blurClear: document.getElementById('btn-blur-clear'),
    autofinish: document.getElementById('chk-autofinish-comp'),
    warn: document.getElementById('stage-warn'),
  };
  const screenVideo = document.createElement('video');
  const camVideo = document.createElement('video');
  screenVideo.muted = camVideo.muted = true;
  screenVideo.playsInline = camVideo.playsInline = true;
  camVideo.addEventListener('loadedmetadata', () => { imgRect = null; }); // re-fit with real dims

  let screenStream = null, camStream = null;
  // Your voice. Its own stream, never tied to the bubble: camera off, or a window/phone in the
  // bubble, and the mic still records. camIsDisplay = the bubble shows a captured window, not
  // the Mac camera (so turning the camera "off" must leave it alone).
  let micStream = null, camIsDisplay = false;
  const callMeter = createCallMeter();
  let callAudioDismissed = false; // "Not needed" (a tutorial) — until the next screen pick
  let recorder = null, audioCtx = null, meta = null;
  let running = false, recording = false;
  let lastFrameAt = 0, stallTimer = null;
  let ticker = null, tickerUrl = null, rafId = null; // preview draw-loop heartbeat (Web Worker; rAF fallback)
  let captureTrack = null;                            // fallback canvas capture track (old browsers)
  // WebCodecs record pipeline (the freeze fix): the recorded frames come from the SOURCE tracks via
  // MediaStreamTrackProcessor (driven by the OS capture, never paused when the page is hidden) →
  // composited → MediaStreamTrackGenerator. recFrame* hold the latest live source frame to draw.
  let pump = null, recFrameScreen = null, recFrameCam = null;
  // The camera IMAGE rect (canvas px), independent of the crop box. Dragging a box edge only
  // moves that edge over this fixed image = a true one-side crop (no rescale/"moving window").
  // Session-only; recovered (cover the box) on activate / size / scroll / shape / ratio changes.
  let imgRect = null;
  const pip = { win: null, canvas: null, timer: null, recBtn: null, dot: null, micBtn: null, micShown: null, callTag: null, callShown: null }; // pop-out monitor
  let locked = false, blurMode = false;
  let bgImg = null; // backdrop image drawn behind a zoomed-out window (persisted server-side)
  let blurs = [];        // rects normalized to the screen video frame {x,y,w,h} 0..1
  let blurDraft = null;  // {x0,y0,x1,y1} canvas px while dragging

  // ---- persisted settings (wF/hF are fractions of canvas WIDTH) ----
  // corrupt localStorage must never brick the app, and restored numbers are always re-clamped
  const safeParse = (key) => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } };
  const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const saved = safeParse(STORE_KEY);
  const legacy = safeParse('ss-composite-v1');
  const bubble = Object.assign(
    { xF: 0.82, yF: 0.86, wF: 0.30, hF: 0.30, shape: 'circle', borderW: 4, borderColor: '#ffffff', radius: 16 },
    typeof legacy.bubble?.sizeF === 'number' ? { ...legacy.bubble, wF: legacy.bubble.sizeF, hF: legacy.bubble.sizeF } : null,
    saved.bubble,
  );
  bubble.xF = num(bubble.xF, 0.82, 0, 1);
  bubble.yF = num(bubble.yF, 0.86, 0, 1);
  bubble.wF = num(bubble.wF, 0.30, 0.1, 0.9);
  bubble.hF = num(bubble.hF, 0.30, 0.1, 1.78);
  bubble.borderW = num(bubble.borderW, 4, 0, 14);
  bubble.radius = num(bubble.radius, 16, 0, 50);
  if (!['circle', 'square', 'off'].includes(bubble.shape)) bubble.shape = 'circle';
  const view = { zoom: 1, panX: 0, panY: 0 };
  // smooth zoom: the wheel/slider move a TARGET; the draw loop eases toward it,
  // keeping the anchor point (under the cursor) pinned — no jumps, no lost control
  let zoomTarget = 1;
  let zoomAnchor = null; // { px, py (screen-video space), cx, cy (canvas px) }
  const zoomEls = { val: document.getElementById('zoom-val') };
  if (saved.fit || legacy.fit) els.fit.value = saved.fit || legacy.fit;
  els.shape.value = bubble.shape;
  els.size.value = Math.round(bubble.wF * 100);
  els.radius.value = bubble.radius;
  els.borderW.value = bubble.borderW;
  els.borderC.value = bubble.borderColor;

  let gridOn = saved.grid ?? true;
  let winRadPx = num(saved.winRad, 0, 0, 60); // floating-window corner radius (1080-ref px); 0 = sharp

  function persist() {
    // The backdrop IMAGE is persisted server-side (see saveBackdrop) — never in localStorage,
    // which a big image would overflow. This only holds small settings.
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ bubble, fit: els.fit.value, grid: gridOn, winRad: winRadPx })); }
    catch {}
  }

  function applyGrid() {
    els.grid.hidden = !gridOn || recording;
    els.gridBtn.classList.toggle('active', gridOn);
  }

  // The canvas ELEMENT is sized to the exact frame (no object-fit letterboxing),
  // so its border/shadow mark the real output frame on the workspace.
  function layoutCanvasElement() {
    const pad = 28;
    const bw = els.stageBox.clientWidth - pad * 2;
    const bh = els.stageBox.clientHeight - pad * 2;
    if (bw <= 0 || bh <= 0) return;
    const ar = W() / H();
    const w = Math.min(bw, bh * ar);
    els.canvas.style.width = `${w}px`;
    els.canvas.style.height = `${w / ar}px`;
  }
  const stageResize = new ResizeObserver(() => { if (running) layoutCanvasElement(); });

  // ---- geometry ----
  const W = () => els.canvas.width, H = () => els.canvas.height;
  const mpx = () => MARGIN * (W() / 1080);

  function sizeCanvas() {
    const [w, h] = CANVAS_SIZE[ctx.getRatio()] || CANVAS_SIZE['9:16'];
    if (els.canvas.width !== w || els.canvas.height !== h) {
      els.canvas.width = w; els.canvas.height = h;
      // hF is a fraction of WIDTH — after a ratio change it may exceed the new height
      bubble.hF = Math.min(bubble.hF, H() / W());
      if (bubble.shape !== 'circle') bubble.wF = Math.min(bubble.wF, 0.9);
      clampView();
      clampBubble();
    }
    layoutCanvasElement();
  }

  function baseScale() {
    const sw = screenVideo.videoWidth, sh = screenVideo.videoHeight;
    if (!sw) return 1;
    return els.fit.value === 'contain' ? Math.min(W() / sw, H() / sh) : Math.max(W() / sw, H() / sh);
  }

  function screenRect() {
    const sw = screenVideo.videoWidth, sh = screenVideo.videoHeight;
    if (!sw) return null;
    const s = baseScale() * view.zoom;
    const dw = sw * s, dh = sh * s;
    let x = (W() - dw) / 2 + view.panX;
    let y = (H() - dh) / 2 + view.panY;
    if (dw >= W()) x = Math.min(0, Math.max(W() - dw, x)); else x = (W() - dw) / 2;
    if (dh >= H()) y = Math.min(0, Math.max(H() - dh, y)); else y = (H() - dh) / 2;
    return { x, y, dw, dh, s };
  }

  function clampView() {
    const r = screenRect();
    if (!r) return;
    view.panX = r.x - (W() - r.dw) / 2;
    view.panY = r.y - (H() - r.dh) / 2;
  }

  function bubbleGeom() {
    const w = bubble.wF * W();
    const h = (bubble.shape === 'circle' ? bubble.wF : bubble.hF) * W();
    return { w, h, x: bubble.xF * W(), y: bubble.yF * H() };
  }

  function clampBubble() {
    const { w, h } = bubbleGeom();
    bubble.xF = Math.min((W() - w / 2) / W(), Math.max((w / 2) / W(), bubble.xF));
    bubble.yF = Math.min((H() - h / 2) / H(), Math.max((h / 2) / H(), bubble.yF));
  }

  // (re)fit the camera image so it just covers the current box, centered — the "uncropped" state.
  // Used on hard reframes (shape/ratio/source change); NOT on size/scroll (those preserve the crop).
  function coverImage() {
    const { w, h, x, y } = bubbleGeom();
    const vw = camVideo.videoWidth || 16, vh = camVideo.videoHeight || 9;
    const s = Math.max(w / vw, h / vh);
    imgRect = { x: x - (vw * s) / 2, y: y - (vh * s) / 2, w: vw * s, h: vh * s };
  }

  // scale the image around a point by the same factor the box grows/shrinks — keeps the crop
  // intact when the whole bubble is resized (size slider / scroll), just bigger or smaller.
  function scaleImageAround(f, cx, cy) {
    if (!imgRect || !(f > 0)) return;
    imgRect.x = cx + (imgRect.x - cx) * f;
    imgRect.y = cy + (imgRect.y - cy) * f;
    imgRect.w *= f;
    imgRect.h *= f;
  }

  // read-only snapshot for tests/debugging — the offset of the image center from the box
  // center is what encodes the crop (0 = uncropped/centered).
  window.__ssBubbleState = () => (imgRect ? {
    offX: (imgRect.x + imgRect.w / 2) - bubble.xF * W(),
    offY: (imgRect.y + imgRect.h / 2) - bubble.yF * H(),
    imgW: imgRect.w, wF: bubble.wF, hF: bubble.hF,
  } : null);

  function bubblePath() {
    const { w, h, x, y } = bubbleGeom();
    const p = new Path2D();
    if (bubble.shape === 'square') {
      const r = (bubble.radius / 100) * Math.min(w, h);
      p.roundRect(x - w / 2, y - h / 2, w, h, r);
    } else {
      p.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
    }
    return p;
  }

  // resize handles: 4 corners + 4 edge midpoints, so the bubble crops freely from ANY side
  const HANDLE_IDS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_CURSOR = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };
  function bubbleEdges() {
    const { w, h, x, y } = bubbleGeom();
    return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
  }
  function handleXY(id) {
    const { left, right, top, bottom } = bubbleEdges();
    return {
      x: id.includes('w') ? left : id.includes('e') ? right : (left + right) / 2,
      y: id.includes('n') ? top : id.includes('s') ? bottom : (top + bottom) / 2,
    };
  }
  function activeHandles() {
    // a circle only crops square → corners only; a square gets all 8 edges + corners
    return bubble.shape === 'circle' ? ['nw', 'ne', 'se', 'sw'] : HANDLE_IDS;
  }
  function hitHandle(p) {
    if (bubble.shape === 'off') return null;
    const r = HANDLE_R * (W() / 1080);
    for (const id of activeHandles()) {
      const hp = handleXY(id);
      if (Math.abs(p.x - hp.x) <= r && Math.abs(p.y - hp.y) <= r) return id;
    }
    return null;
  }

  // ---- drawing ----
  const snapped = { cx: false, cy: false };

  // the backdrop behind a floating (zoomed-out) window: a chosen image, cover-fit, else a
  // brand-dark radial glow so the frame is never empty black. The gradient is cached (rebuilding
  // it every frame was needless work while recording).
  let bgGrad = null, bgGradKey = '';
  function drawBackdrop(c) {
    if (bgImg && bgImg.complete && bgImg.naturalWidth) {
      const s = Math.max(W() / bgImg.naturalWidth, H() / bgImg.naturalHeight);
      const dw = bgImg.naturalWidth * s, dh = bgImg.naturalHeight * s;
      c.drawImage(bgImg, (W() - dw) / 2, (H() - dh) / 2, dw, dh);
    } else {
      const key = `${W()}x${H()}`;
      if (bgGradKey !== key || !bgGrad) {
        bgGrad = c.createRadialGradient(W() / 2, H() * 0.42, W() * 0.1, W() / 2, H() / 2, H() * 0.75);
        bgGrad.addColorStop(0, '#1b1f2b');
        bgGrad.addColorStop(1, '#07070b');
        bgGradKey = key;
      }
      c.fillStyle = bgGrad;
      c.fillRect(0, 0, W(), H());
    }
  }

  // The floating-window drop shadow is expensive (a big canvas blur), and it only depends on the
  // window rect + radius — so render it once to an offscreen and blit it each frame. Doing the
  // blur every frame was a big chunk of the recording lag.
  let shadowCanvas = null, shadowKey = '';
  function floatingShadow(r, rad) {
    const key = `${W()}x${H()}|${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.dw)},${Math.round(r.dh)},${Math.round(rad)}`;
    if (shadowKey === key && shadowCanvas) return shadowCanvas;
    shadowCanvas = shadowCanvas || document.createElement('canvas');
    if (shadowCanvas.width !== W() || shadowCanvas.height !== H()) { shadowCanvas.width = W(); shadowCanvas.height = H(); }
    const sc = shadowCanvas.getContext('2d');
    sc.clearRect(0, 0, W(), H());
    sc.save();
    sc.shadowColor = 'rgba(0,0,0,0.42)';
    sc.shadowBlur = Math.round(W() * 0.025);
    sc.shadowOffsetY = Math.round(W() * 0.01);
    sc.fillStyle = '#000';
    const p = new Path2D();
    p.roundRect(r.x, r.y, r.dw, r.dh, rad);
    sc.fill(p);
    sc.restore();
    shadowKey = key;
    return shadowCanvas;
  }

  // The backdrop is one of the bundled backgrounds (public/backgrounds/), your own image, or none
  // (the brand-dark glow). Your image is stored on the SERVER as a single file, so it survives
  // reloads and restarts regardless of size — localStorage would overflow on a real photo. Only the
  // choice itself lives in localStorage; a first run gets the default background.
  const BACKDROP_URL = '/api/screener/backdrop';
  const BG_KEY = 'ss-backdrop'; // '<background id>' | 'custom' | 'none'
  const BG_DEFAULT = 'segan-dunes';
  let bgPresets = [], bgReady = false;
  const bgChoice = () => { try { return localStorage.getItem(BG_KEY) || BG_DEFAULT; } catch { return BG_DEFAULT; } };

  function loadBackdrop() {
    const choice = bgChoice();
    markSwatch(choice);
    els.bgClear.hidden = choice === 'none';
    const preset = bgPresets.find((p) => p.id === choice);
    const src = choice === 'custom' ? `${BACKDROP_URL}?t=${Date.now()}` : preset ? `/backgrounds/${preset.file}` : null;
    if (!src) { bgImg = null; return; } // 'none', or a background that no longer ships
    const img = new Image();
    // a quick double-click across swatches: only the image still chosen when it lands is used
    img.onload = () => { if (bgChoice() === choice) bgImg = img; };
    img.onerror = () => { if (bgChoice() === choice) bgImg = null; };
    img.src = src;
  }
  function chooseBackdrop(id) {
    try { localStorage.setItem(BG_KEY, id); } catch {}
    loadBackdrop();
    if (id === 'none') return ctx.toast('No backdrop — a plain dark glow fills the frame');
    const name = id === 'custom' ? 'your image' : bgPresets.find((p) => p.id === id)?.name;
    ctx.toast(`Backdrop: ${name} — zoom out below 100% to float the window on it`);
  }
  async function saveBackdrop(file) {
    try {
      await screenerBackdropSave(file);
      addCustomSwatch();
      chooseBackdrop('custom');
    } catch (e) { ctx.toast(`Backdrop save failed: ${e.message}`, true); }
  }

  function swatch(id, name, thumb) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'bg-swatch'; b.dataset.bg = id; b.title = name;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-label', name);
    const img = document.createElement('img');
    img.alt = ''; img.src = thumb;
    b.append(img);
    b.onclick = () => chooseBackdrop(id);
    return b;
  }
  function markSwatch(choice) {
    for (const b of els.bgGallery.children) b.setAttribute('aria-checked', String(b.dataset.bg === choice));
  }
  // Your uploaded image gets the first swatch — shown only once the server actually has one.
  function addCustomSwatch() {
    els.bgGallery.querySelector('[data-bg="custom"]')?.remove();
    const s = swatch('custom', 'Your image', `${BACKDROP_URL}?t=${Date.now()}`);
    s.hidden = true;
    s.querySelector('img').onload = () => { s.hidden = false; };
    els.bgGallery.prepend(s);
    markSwatch(bgChoice());
  }
  async function initBackdrops() {
    if (!bgReady) {
      bgReady = true;
      try { bgPresets = await fetch('/backgrounds/backgrounds.json').then((r) => r.json()); } catch { bgPresets = []; }
      els.bgGallery.replaceChildren(...bgPresets.map((p) => swatch(p.id, p.name, `/backgrounds/${p.thumb}`)));
      addCustomSwatch();
    }
    loadBackdrop();
  }

  function drawBlurs(c, r, screenImg) {
    const blurPx = Math.round(22 * (W() / 1080));
    for (const b of blurs) {
      const dx = r.x + b.x * r.dw, dy = r.y + b.y * r.dh;
      const dw = b.w * r.dw, dh = b.h * r.dh;
      if (dx > W() || dy > H() || dx + dw < 0 || dy + dh < 0) continue;
      c.save();
      c.beginPath();
      c.rect(dx, dy, dw, dh);
      c.clip();
      c.filter = `blur(${blurPx}px)`;
      c.drawImage(screenImg, r.x, r.y, r.dw, r.dh);
      c.restore();
      if (!recording && blurMode) {
        c.strokeStyle = 'rgba(239,181,25,0.9)';
        c.lineWidth = 2;
        c.setLineDash([8, 8]);
        c.strokeRect(dx, dy, dw, dh);
        c.setLineDash([]);
      }
    }
  }

  function draw() {
    const c = els.canvas.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high'; // cleaner scaling at deep zoom
    c.fillStyle = '#000';
    c.fillRect(0, 0, W(), H());

    // pixel sources: live source VideoFrames while recording (never stale when hidden), else the
    // <video> elements for the preview.
    const screenImg = recFrameScreen || screenVideo;
    const camImg = recFrameCam || camVideo;

    const r = screenRect();
    if (r) {
      // zoomed out → the window is smaller than the frame: lay a backdrop behind it, with a
      // user-set corner radius + a soft shadow so it "floats" (the OBS minimal look).
      const floating = r.dw < W() - 1 || r.dh < H() - 1;
      if (floating) {
        drawBackdrop(c);
        const rad = winRadPx * (W() / 1080); // 0 = sharp corners (default)
        c.drawImage(floatingShadow(r, rad), 0, 0); // cached soft shadow (cheap blit, no per-frame blur)
        const wp = new Path2D();
        wp.roundRect(r.x, r.y, r.dw, r.dh, rad);
        c.save();
        c.clip(wp);
        c.drawImage(screenImg, r.x, r.y, r.dw, r.dh);
        if (blurs.length) drawBlurs(c, r, screenImg);
        c.restore();
      } else {
        c.drawImage(screenImg, r.x, r.y, r.dw, r.dh);
        if (blurs.length) drawBlurs(c, r, screenImg);
      }
    } else {
      // empty state — recording is impossible without a screen, so this never gets encoded
      c.fillStyle = 'rgba(166,171,185,0.75)';
      c.font = `600 ${Math.round(34 * (W() / 1080))}px 'Space Grotesk', -apple-system, sans-serif`;
      c.textAlign = 'center';
      c.fillText('Choose a screen / window…', W() / 2, H() / 2 - 10);
      c.font = `500 ${Math.round(22 * (W() / 1080))}px Montserrat, -apple-system, sans-serif`;
      c.fillStyle = 'rgba(107,112,128,0.8)';
      c.fillText('your face bubble is already live below', W() / 2, H() / 2 + 42 * (W() / 1080));
      c.textAlign = 'start';
    }

    if (bubble.shape !== 'off' && camVideo.videoWidth) {
      if (!imgRect) coverImage();
      const path = bubblePath();
      c.save();
      c.clip(path);
      // draw the fixed image; the box (clip path) is the crop window over it
      c.drawImage(camImg, imgRect.x, imgRect.y, imgRect.w, imgRect.h);
      c.restore();
      if (bubble.borderW > 0) {
        c.lineWidth = bubble.borderW * (W() / 1080);
        c.strokeStyle = bubble.borderColor;
        c.stroke(path);
      }
      // resize handles — small dots on every corner + edge (never encoded). Shown only while
      // hovering the bubble or actively resizing, so they don't clutter the frame otherwise.
      const showHandles = !recording && !locked &&
        (hoverBubble || (drag && (drag.target === 'resize' || drag.target === 'bubble')));
      if (showHandles) {
        const hs = 10 * (W() / 1080); // small + minimal (was a big 22px single handle)
        c.fillStyle = '#fff';
        c.strokeStyle = 'rgba(7,7,11,0.6)';
        c.lineWidth = 1.5;
        for (const id of activeHandles()) {
          const hp = handleXY(id);
          c.beginPath();
          c.roundRect(hp.x - hs / 2, hp.y - hs / 2, hs, hs, 2.5);
          c.fill();
          c.stroke();
        }
      }
    }

    if (!recording && blurDraft) {
      c.strokeStyle = 'rgba(239,181,25,0.95)';
      c.lineWidth = 2;
      c.setLineDash([8, 8]);
      c.strokeRect(Math.min(blurDraft.x0, blurDraft.x1), Math.min(blurDraft.y0, blurDraft.y1),
        Math.abs(blurDraft.x1 - blurDraft.x0), Math.abs(blurDraft.y1 - blurDraft.y0));
      c.setLineDash([]);
    }

    if (!recording && (snapped.cx || snapped.cy)) {
      c.strokeStyle = 'rgba(36,108,248,0.9)';
      c.lineWidth = 2;
      c.setLineDash([10, 10]);
      c.beginPath();
      if (snapped.cx) { c.moveTo(W() / 2, 0); c.lineTo(W() / 2, H()); }
      if (snapped.cy) { c.moveTo(0, H() / 2); c.lineTo(W(), H() / 2); }
      c.stroke();
      c.setLineDash([]);
    }
    lastFrameAt = performance.now();
  }

  function syncZoomUi() {
    els.zoom.value = Math.round(view.zoom * 100);
    zoomEls.val.textContent = `${view.zoom.toFixed(1)}×`;
  }

  function stepZoom() {
    if (Math.abs(zoomTarget - view.zoom) < 0.002) {
      if (zoomTarget !== view.zoom) { view.zoom = zoomTarget; clampView(); syncZoomUi(); }
      return;
    }
    view.zoom += (zoomTarget - view.zoom) * 0.22; // ease toward the target
    if (zoomAnchor) {
      const s2 = baseScale() * view.zoom;
      view.panX = (zoomAnchor.cx - zoomAnchor.px * s2) - (W() - screenVideo.videoWidth * s2) / 2;
      view.panY = (zoomAnchor.cy - zoomAnchor.py * s2) - (H() - screenVideo.videoHeight * s2) / 2;
    }
    clampView();
    syncZoomUi();
  }

  const DRAW_MS = 1000 / 30; // ~30fps: we only encode 30, so painting faster just wasted
                             // CPU/GPU (heat) on a fanless Air — no visible gain
  let lastRaf = 0;

  // One PREVIEW draw tick: ease the zoom, paint the canvas, mirror to PiP. While recording through
  // the WebCodecs pump, the pump owns the canvas (drives draw off live source frames), so we skip.
  function tick() {
    if (!running) return;
    stepZoom();
    draw(); // sets lastFrameAt
    if (recording && pump) {
      // Worker-driven output: emit a frame EVERY tick, not per source-frame. When the window is
      // hidden the source's frame delivery is throttled — but this worker heartbeat is not, and
      // VideoFrame(canvas) is not rendering-gated, so recording keeps going. recFrame* hold the
      // latest source frames (static if delivery stalled). inflight caps queued frames so a slow
      // encoder just drops frames instead of stalling. THIS is the long-recording freeze fix.
      if (pump.inflight < 2 && (recFrameScreen || screenVideo.videoWidth)) {
        pump.inflight++;
        try {
          const out = new VideoFrame(els.canvas, { timestamp: Math.round(performance.now() * 1000) });
          pump.writer.write(out).catch((e) => logError('pump.writer.write', e)).finally(() => { out.close(); pump.inflight--; });
        } catch (e) { logError('pump.emit', e); pump.inflight--; }
      }
    } else if (recording && captureTrack) {
      try { captureTrack.requestFrame(); } catch {} // old-browser fallback path
    }
    if (pip.win) mirrorToPip();
  }

  // The draw clock. THE FREEZE BUG: a hidden OR occluded browser window throttles
  // requestAnimationFrame to ~0 — so past recordings froze whenever another window covered
  // Chrome (macOS occlusion) or the tab was switched, even with the pop-out open. A Web
  // Worker's timer is exempt from that throttling, and the live mic keeps the page from being
  // frozen, so this keeps painting a steady 30fps no matter what's on screen. rAF is only a
  // fallback for the (theoretical) browser without Workers.
  function startLoop() {
    if (ticker || rafId) return; // already ticking
    try {
      // A self-pacing heartbeat: the worker fires a tick, then waits for the main thread's ACK
      // before scheduling the next — so it can NEVER outrun the main thread. (The old blind
      // setInterval flooded the main thread when a tick took >33ms and froze the page.) A worker's
      // setTimeout is exempt from background throttling, so it still fires when the tab is hidden.
      const src = 'let ms=33,on=false,t0=0;'
        + 'function fire(){if(on){t0=Date.now();postMessage(0);}}'
        + 'onmessage=function(e){var d=e.data;'
        + 'if(d==="ack"){if(on)setTimeout(fire,Math.max(0,ms-(Date.now()-t0)));}'
        + 'else if(d==="stop"){on=false;}'
        + 'else{ms=d||33;if(!on){on=true;fire();}}};';
      tickerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      ticker = new Worker(tickerUrl);
      ticker.onmessage = () => { try { tick(); } finally { if (ticker) ticker.postMessage('ack'); } };
      ticker.postMessage(DRAW_MS);
    } catch {
      const step = (now) => {
        if (!running) { rafId = null; return; }
        if (now - lastRaf >= DRAW_MS) { lastRaf = now; tick(); }
        rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    }
  }

  function stopLoop() {
    if (ticker) { try { ticker.postMessage('stop'); ticker.terminate(); } catch {} ticker = null; }
    if (tickerUrl) { URL.revokeObjectURL(tickerUrl); tickerUrl = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ---- pop-out monitor (Document Picture-in-Picture) ----
  // Floats the live composite in an always-on-top window so you can record while
  // working in ANY other app/tab without the canvas freezing. Also carries a
  // Record/Stop button + timer so you never need to return to the studio tab.
  function mirrorToPip() {
    if (!pip.canvas) return;
    const pc = pip.canvas;
    if (pc.width !== els.canvas.width || pc.height !== els.canvas.height) {
      pc.width = els.canvas.width; pc.height = els.canvas.height;
    }
    pc.getContext('2d').drawImage(els.canvas, 0, 0);
    if (pip.timer) {
      const rec = ctx.isRecording();
      pip.dot.style.visibility = rec ? 'visible' : 'hidden';
      pip.timer.textContent = rec ? fmtElapsed(ctx.recElapsed()) : 'ready';
      pip.recBtn.classList.toggle('rec', rec);
    }
    const muted = !!ctx.isMicMuted?.();
    if (pip.micBtn && pip.micShown !== muted) { // only touch the DOM when it changes (this runs every frame)
      pip.micShown = muted;
      pip.micBtn.textContent = muted ? '🔇 Muted' : '🎙 Mic on';
      pip.micBtn.style.background = muted ? '#e5484d' : '#1c1e2a';
    }
    const call = !!screenStream?.getAudioTracks().some((t) => t.readyState === 'live');
    if (pip.callTag && pip.callShown !== call) {
      pip.callShown = call;
      pip.callTag.textContent = call ? '🔊 Call audio' : 'No call audio';
      pip.callTag.style.color = call ? '#30a46c' : '#efb519';
    }
  }
  function fmtElapsed(s) {
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  async function openMonitor() {
    if (!window.documentPictureInPicture) {
      ctx.toast('Pop-out needs Chrome 116+ — update Chrome to use the floating monitor', true);
      return;
    }
    if (pip.win) { pip.win.focus(); return; }
    const [w, h] = CANVAS_SIZE[ctx.getRatio()] || [1080, 1920];
    const win = await window.documentPictureInPicture.requestWindow({
      width: Math.round(360 * (w / h) + 0.5) || 220, height: 420,
    });
    pip.win = win;
    win.document.body.style.cssText = 'margin:0;background:#07070b;font-family:-apple-system,sans-serif;overflow:hidden;display:flex;flex-direction:column;';
    const bar = win.document.createElement('div');
    bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;background:#101119;color:#f5f6fa;font:600 13px -apple-system;';
    pip.recBtn = win.document.createElement('button');
    pip.recBtn.textContent = '●';
    pip.recBtn.style.cssText = 'width:30px;height:30px;border-radius:50%;border:2px solid #2a2c38;background:#e5484d;color:#fff;cursor:pointer;font-size:12px;';
    pip.recBtn.onclick = () => ctx.monitorToggleRecord();
    pip.dot = win.document.createElement('span');
    pip.dot.textContent = '● REC';
    pip.dot.style.cssText = 'color:#e5484d;font-weight:700;visibility:hidden;';
    pip.timer = win.document.createElement('span');
    pip.timer.textContent = 'ready';
    pip.timer.style.cssText = 'margin-left:auto;font-variant-numeric:tabular-nums;';
    // Mute from inside a meeting without switching back to the studio tab (click, or M here).
    pip.micBtn = win.document.createElement('button');
    pip.micBtn.style.cssText = 'height:26px;padding:0 10px;border-radius:13px;border:1px solid #2a2c38;color:#fff;cursor:pointer;font:600 12px -apple-system;';
    pip.micBtn.onclick = () => ctx.toggleMicMute?.();
    pip.micShown = null; // force the first paint
    pip.callTag = win.document.createElement('span');
    pip.callTag.style.cssText = 'font:600 11px -apple-system;';
    pip.callShown = null;
    win.document.addEventListener('keydown', (e) => {
      if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) ctx.toggleMicMute?.();
    });
    bar.append(pip.recBtn, pip.dot, pip.micBtn, pip.callTag, pip.timer);
    pip.canvas = win.document.createElement('canvas');
    pip.canvas.style.cssText = 'flex:1 1 auto;width:100%;min-height:0;object-fit:contain;background:#000;';
    win.document.body.append(bar, pip.canvas);
    win.addEventListener('pagehide', () => closeMonitor());
    els.popout?.classList.add('active');
    els.popout && (els.popout.textContent = '⧉ Close pop-out');
    // no need to re-home the loop: the worker heartbeat keeps painting; once pip.win is set
    // the next tick starts mirroring. The pop-out is now a convenience, not a freeze fix.
    ctx.toast('Monitor popped out — a floating view so you can see yourself. Recording no longer depends on it.');
  }

  function closeMonitor() {
    if (pip.win) { try { pip.win.close(); } catch {} }
    pip.win = pip.canvas = pip.timer = pip.recBtn = pip.dot = pip.micBtn = pip.callTag = null;
    els.popout?.classList.remove('active');
    els.popout && (els.popout.textContent = '⧉ Pop-out monitor');
    // nothing to restart — the worker heartbeat never stopped; ticks just stop mirroring now
  }

  // ---- pointer interaction (only inside the output frame) ----
  function toCanvas(e) {
    // the canvas element IS the frame now (no object-fit letterboxing)
    const rect = els.canvas.getBoundingClientRect();
    const scale = W() / rect.width;
    const p = {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * scale,
    };
    p.inside = p.x >= 0 && p.x <= W() && p.y >= 0 && p.y <= H();
    return p;
  }

  function overBubble(p) {
    if (bubble.shape === 'off') return false;
    const { w, h, x, y } = bubbleGeom();
    return bubble.shape === 'square' || bubble.shape === 'circle'
      ? Math.abs(p.x - x) <= w / 2 && Math.abs(p.y - y) <= h / 2
      : false;
  }

  let drag = null; // { target: 'bubble'|'view'|'resize'|'blur', id, fixed, last }
  let hoverBubble = false; // show the resize handles only while the pointer is over the bubble

  function snapAxis(v, candidates, tol) {
    for (const cand of candidates) if (Math.abs(v - cand) < tol) return cand;
    return null;
  }

  function moveBubble(p) {
    const { w, h } = bubbleGeom();
    const m = mpx(), tol = 18;
    const oldX = bubble.xF * W(), oldY = bubble.yF * H();
    let x = Math.min(W() - w / 2, Math.max(w / 2, p.x));
    let y = Math.min(H() - h / 2, Math.max(h / 2, p.y));
    const sx = snapAxis(x, [W() / 2, m + w / 2, W() - m - w / 2], tol);
    const sy = snapAxis(y, [H() / 2, m + h / 2, H() - m - h / 2], tol);
    snapped.cx = sx === W() / 2; snapped.cy = sy === H() / 2;
    if (sx !== null) x = sx;
    if (sy !== null) y = sy;
    bubble.xF = x / W(); bubble.yF = y / H();
    if (imgRect) { imgRect.x += x - oldX; imgRect.y += y - oldY; } // image travels with the box
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('#prompter') || e.target.closest('.countdown')) return; // they own their input
    const p = toCanvas(e);
    if (blurMode) {
      // blur drawing works even while LOCKED, and can start OUTSIDE the frame —
      // handy for edge junk (ads, borders) and areas behind the bubble
      drag = { target: 'blur' };
      blurDraft = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else if (!p.inside || locked) {
      return;
    } else if (hitHandle(p)) {
      drag = { target: 'resize', id: hitHandle(p), fixed: bubbleEdges() };
    } else if (overBubble(p)) {
      drag = { target: 'bubble', last: p };
    } else {
      drag = { target: 'view', last: p };
      zoomAnchor = null; // panning takes over — the zoom anchor must not fight the drag
    }
    els.stageBox.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function onPointerLeave() {
    if (!drag) hoverBubble = false; // pointer left the stage → hide the handles
  }

  function onPointerMove(e) {
    const p = toCanvas(e);
    if (!drag) {
      const hid = p.inside ? hitHandle(p) : null;
      hoverBubble = !blurMode && !locked && p.inside && (!!hid || overBubble(p));
      els.stageBox.style.cursor = blurMode ? 'crosshair'
        : locked ? 'default'
        : hid ? HANDLE_CURSOR[hid]
        : overBubble(p) && p.inside ? 'grab'
        : (p.inside && view.zoom > 1) ? 'move' : 'default';
      return;
    }
    if (drag.target === 'blur') {
      blurDraft.x1 = p.x; // free to run past the frame edges
      blurDraft.y1 = p.y;
    } else if (drag.target === 'resize') {
      const minPx = 80 * (W() / 1080);
      const id = drag.id;
      // move only the dragged edge(s); the opposite edge(s) stay pinned where the drag began
      let { left, right, top, bottom } = drag.fixed;
      if (id.includes('w')) left = p.x;
      if (id.includes('e')) right = p.x;
      if (id.includes('n')) top = p.y;
      if (id.includes('s')) bottom = p.y;
      if (bubble.shape === 'circle') {
        // a circle can't crop one side — resize the square (anchored opposite) + re-cover
        if (right - left < minPx) { if (id.includes('w')) left = right - minPx; else right = left + minPx; }
        if (bottom - top < minPx) { if (id.includes('n')) top = bottom - minPx; else bottom = top + minPx; }
        const d = Math.max(right - left, bottom - top);
        bubble.wF = d / W(); bubble.hF = d / W();
        bubble.xF = (id.includes('w') ? right - d / 2 : left + d / 2) / W();
        bubble.yF = (id.includes('n') ? bottom - d / 2 : top + d / 2) / H();
        clampBubble();
        coverImage();
      } else {
        // square = TRUE one-side crop: the image stays fixed, only the dragged edge of the crop
        // window moves. Clamp within the image so we never reveal past the photo (no black).
        if (imgRect) {
          left = Math.max(left, imgRect.x); right = Math.min(right, imgRect.x + imgRect.w);
          top = Math.max(top, imgRect.y); bottom = Math.min(bottom, imgRect.y + imgRect.h);
        }
        if (right - left < minPx) { if (id.includes('w')) left = right - minPx; else right = left + minPx; }
        if (bottom - top < minPx) { if (id.includes('n')) top = bottom - minPx; else bottom = top + minPx; }
        bubble.wF = (right - left) / W();
        bubble.hF = (bottom - top) / W(); // hF is a fraction of WIDTH, matching bubbleGeom()
        bubble.xF = (left + right) / 2 / W();
        bubble.yF = (top + bottom) / 2 / H();
      }
      els.size.value = Math.round(bubble.wF * 100);
    } else if (drag.target === 'bubble') {
      moveBubble(p);
    } else {
      view.panX += p.x - drag.last.x;
      view.panY += p.y - drag.last.y;
      clampView();
    }
    drag.last = p;
  }

  function finishBlurDraft() {
    const r = screenRect();
    if (!r) { blurDraft = null; ctx.toast('Share a screen first, then draw blurs on it', true); return; }
    if (!blurDraft) return;
    const x0 = Math.min(blurDraft.x0, blurDraft.x1), y0 = Math.min(blurDraft.y0, blurDraft.y1);
    const w = Math.abs(blurDraft.x1 - blurDraft.x0), h = Math.abs(blurDraft.y1 - blurDraft.y0);
    blurDraft = null;
    if (w < 10 || h < 10) {
      // treat as a click: remove the blur under the cursor
      const bx = (x0 - r.x) / r.dw, by = (y0 - r.y) / r.dh;
      const i = blurs.findIndex((b) => bx >= b.x && bx <= b.x + b.w && by >= b.y && by <= b.y + b.h);
      if (i >= 0) { blurs.splice(i, 1); ctx.toast('Blur removed'); }
      return;
    }
    blurs.push({
      x: (x0 - r.x) / r.dw, y: (y0 - r.y) / r.dh,
      w: w / r.dw, h: h / r.dh,
    });
    ctx.toast(`Blur added (${blurs.length})`);
  }

  function onPointerUp(e) {
    if (!drag) return;
    const wasBlur = drag.target === 'blur';
    drag = null;
    snapped.cx = snapped.cy = false;
    try { els.stageBox.releasePointerCapture(e.pointerId); } catch {}
    if (wasBlur) finishBlurDraft();
    else persist();
  }

  function onWheel(e) {
    if (e.target.closest('#prompter')) return; // the prompter scrolls its own text
    if (locked || blurMode) return;
    const p = toCanvas(e);
    if (!p.inside) return; // the wheel only acts inside the output frame
    e.preventDefault();
    if (overBubble(p) || hitHandle(p)) {
      let f = Math.exp(-e.deltaY * 0.0012);
      // Clamp the FACTOR (not wF/hF separately) so the box and the camera image scale by the
      // exact same amount — otherwise, at a size limit, the box stops but the image keeps
      // scaling and the resize handles drift off the camera (the "handles don't follow" bug).
      f = Math.min(f, 0.9 / bubble.wF, 1.6 / bubble.hF); // cap growth
      f = Math.max(f, 0.1 / bubble.wF, 0.1 / bubble.hF); // cap shrink
      bubble.wF *= f;
      bubble.hF *= f;
      els.size.value = Math.round(bubble.wF * 100);
      const cx = bubble.xF * W(), cy = bubble.yF * H();
      clampBubble();
      scaleImageAround(f, cx, cy); // same f → crop preserved, handles stay locked to the box
      hoverBubble = true;          // keep the handles visible + tracking while wheel-zooming
      persist();
      return;
    }
    const before = screenRect();
    if (!before) return;
    // continuous factor (proportional to scroll speed) + eased in the draw loop
    zoomTarget = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomTarget * Math.exp(-e.deltaY * 0.0018)));
    zoomAnchor = {
      px: (p.x - before.x) / before.s,
      py: (p.y - before.y) / before.s,
      cx: p.x, cy: p.y,
    };
  }

  function applyPreset(key) {
    const { w, h } = bubbleGeom();
    const m = mpx();
    const xs = { l: m + w / 2, c: W() / 2, r: W() - m - w / 2 };
    const ys = { t: m + h / 2, b: H() - m - h / 2 };
    const oldX = bubble.xF * W(), oldY = bubble.yF * H();
    bubble.yF = ys[key[0]] / H();
    bubble.xF = xs[key[1]] / W();
    if (imgRect) { imgRect.x += bubble.xF * W() - oldX; imgRect.y += bubble.yF * H() - oldY; } // move crop with box
    persist();
  }

  // ---- lock / blur mode ----
  const LOCKABLE = () => [els.ratio, els.zoom, els.fit, els.viewReset, els.shape, els.pos, els.size, els.radius, els.borderW, els.borderC];

  function setLocked(v) {
    locked = v;
    els.lock.classList.toggle('active', v); // CSS swaps the lock icon off this class
    LOCKABLE().forEach((el) => { el.disabled = v; });
    if (v && blurMode) setBlurMode(false);
  }

  function setBlurMode(v) {
    blurMode = v;
    els.blurAdd.classList.toggle('mode-active', v);
    els.blurAdd.textContent = v ? 'Drag a box… (Esc to exit)' : 'Add blur area';
    els.stageBox.classList.toggle('blur-mode', v);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && blurMode) setBlurMode(false);
  }

  // ---- streams ----
  // The MAIN (full-frame) source. Screen or the phone-mirror window are both just
  // windows to getDisplayMedia — picking the phone mirror = "phone as the main video",
  // and all the crop/zoom/blur machinery below applies to it unchanged.
  async function pickScreen() {
    if (els.mainSource.value === 'phone') {
      ctx.toast('In the picker, choose the “PHONE MIRROR” window (open it from the Phone tab first)');
    }
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } }, // steady 30 — no bursty over-delivery
      audio: true, // Chrome shows an "also share audio" toggle (tab always; system on macOS 14.2+)
    });
    screenVideo.srcObject = screenStream;
    await screenVideo.play();
    view.zoom = 1; view.panX = 0; view.panY = 0;
    els.zoom.value = 100;
    blurs = []; // blurs are anchored to the previous content
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      logEvent('screenShare.ended', { recording, note: recording ? 'ended MID-RECORD → auto-stop (likely the captured window was covered/minimized)' : 'ended while idle' });
      if (recording) ctx.stopFromUi();
      ctx.setReady(false);
      ctx.toast('Screen sharing ended');
      updateCallAudioUi();
    });
    screenStream.getAudioTracks().forEach((t) => t.addEventListener('ended', updateCallAudioUi));
    callAudioDismissed = false; // a new share is a new decision
    logEvent('screenShare.picked', { hasSystemAudio: screenStream.getAudioTracks().length > 0 });
    ctx.setReady(true);
    updateCallAudioUi();
  }

  // The other side of a call is only in the recording if the screen share carries audio — Chrome's
  // "Share with system audio" switch. Nothing used to show its absence, so a whole meeting could save
  // without the other side. Now it's visible the moment you pick, before you press Record.
  function updateCallAudioUi() {
    const shared = !!screenStream?.getVideoTracks().some((t) => t.readyState === 'live');
    const hasCallAudio = !!screenStream?.getAudioTracks().some((t) => t.readyState === 'live');
    els.callWarn.hidden = !running || !shared || hasCallAudio || callAudioDismissed;
    if (running && shared && hasCallAudio) callMeter.attach(screenStream);
    else callMeter.detach();
  }

  // The BUBBLE source: the Mac camera (default) OR a captured window — pick the
  // phone-mirror window to put the phone in the bubble, or a screen for a screen insert.
  function stopCam() {
    if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
    camIsDisplay = false;
    camVideo.srcObject = null; // a stopped stream keeps its last frame — never draw a frozen face
  }
  async function openBubbleCamera() {
    stopCam();
    camStream = await openCameraVideo(document.getElementById('sel-cam').value || undefined);
    camVideo.srcObject = camStream;
    await camVideo.play();
  }
  async function openBubbleDisplay() {
    // getDisplayMedia needs a user gesture — this runs from the "Pick…" button click
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    stopCam();
    camStream = s;
    camIsDisplay = true;
    camVideo.srcObject = camStream;
    await camVideo.play();
    camStream.getVideoTracks()[0].addEventListener('ended', () => ctx.toast('Bubble source window closed'));
  }

  // Face bubble "Off" = the Mac camera is OFF (green light out). Only between takes: during a take
  // the recorder reads the camera track it started with, so a camera re-opened mid-take could never
  // reach the file — there, Off just hides the bubble, and the camera goes off when the take ends.
  async function syncCamera() {
    if (recording) return;
    const want = els.bubbleSource.value === 'camera' && bubble.shape !== 'off';
    const camLive = !camIsDisplay && !!camStream?.getVideoTracks().some((t) => t.readyState === 'live');
    if (want && !camLive) await openBubbleCamera();
    else if (!want && camStream && !camIsDisplay) stopCam();
  }
  function unlockShape() { els.shape.disabled = false; els.shape.removeAttribute('title'); }

  // ---- the microphone (independent of the bubble) ----
  async function refreshMicList() {
    const { mics } = await listDevices();
    fillDeviceSelect(els.mic, mics, 'Microphone', 'ss-mic');
  }
  function stopMic() {
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }
  async function openMicStream() {
    stopMic();
    const want = els.mic.value || localStorage.getItem('ss-mic') || undefined;
    try { micStream = await openMic(want); }
    catch { micStream = await openMic(undefined); } // saved mic gone (AirPods away) → default mic, never silence
    micStream.getAudioTracks().forEach((t) => { t.enabled = !ctx.isMicMuted?.(); }); // a new mic keeps the mute
    await refreshMicList().catch(() => {}); // labels are readable now that a mic is open
    const actual = micStream.getAudioTracks()[0]?.getSettings?.().deviceId;
    if (actual && [...els.mic.options].some((o) => o.value === actual)) els.mic.value = actual;
    ctx.meter?.attach(micStream);
  }
  const onDeviceChange = () => { if (!recording) refreshMicList().catch(() => {}); };
  function applyBubbleSourceUi() {
    els.bubblePick.hidden = els.bubbleSource.value !== 'display';
  }

  function mixedAudioTrack() {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    if (micStream?.getAudioTracks().length) {
      audioCtx.createMediaStreamSource(new MediaStream(micStream.getAudioTracks())).connect(dest);
    }
    if (screenStream?.getAudioTracks().length) {
      audioCtx.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks())).connect(dest);
    }
    return dest.stream.getAudioTracks()[0] || null;
  }

  // Is any compositing feature active? If so we must render through the pump/canvas; if not
  // (plain screen — no bubble/backdrop/zoom/pan/blur) we record the raw OS track directly, the
  // lightest, freeze-proof path for multi-hour. Err toward compositing: never silently drop a
  // blur box or the face bubble.
  function compositeActive() {
    // A hidden bubble ("Off") never forces the heavier pump path — nothing of it would be drawn.
    const bubbleLive = bubble.shape !== 'off' && !!camStream?.getVideoTracks?.().some((t) => t.readyState === 'live');
    const panned = view.zoom !== 1 || view.panX !== 0 || view.panY !== 0;
    // A saved backdrop only forces compositing when the window doesn't fill the frame — i.e. when
    // you'd actually SEE it (contain/Fit or zoomed out). A full-frame window hides the backdrop, so
    // plain screen stays on the raw, freeze-proof path even with a backdrop saved from a past session.
    const r = screenRect();
    const backdropVisible = !!bgImg && (!r || r.dw < W() - 1 || r.dh < H() - 1);
    return bubbleLive || backdropVisible || blurs.length > 0 || panned;
  }

  // ---- the record pipeline (freeze-proof) ----
  const canInsertable = () =>
    typeof window.MediaStreamTrackProcessor === 'function' && typeof window.MediaStreamTrackGenerator === 'function';

  // Build the recorded video track from the LIVE source frames instead of canvas.captureStream.
  // canvas.captureStream is gated on the page's rendering, which the browser PAUSES when the tab
  // is hidden/occluded → the old "froze at 3s of 36s" bug. MediaStreamTrackProcessor pulls frames
  // straight from the capture track (driven by the OS, never paused), we composite them onto the
  // canvas, and MediaStreamTrackGenerator emits the result — all immune to page visibility.
  function startInsertablePump(screenTrack, audioTrack) {
    const gen = new MediaStreamTrackGenerator({ kind: 'video' });
    const writer = gen.writable.getWriter();
    const screenReader = new MediaStreamTrackProcessor({ track: screenTrack }).readable.getReader();
    const camTrack = camStream?.getVideoTracks?.()[0];
    const camReader = (camTrack && camTrack.readyState === 'live')
      ? new MediaStreamTrackProcessor({ track: camTrack }).readable.getReader() : null;
    pump = { gen, writer, screenReader, camReader, stop: false, inflight: 0 };

    // The source loops do ONE job: keep recFrame* pointing at the latest live frame. The worker
    // tick() does the compositing + emitting (see tick), so output never depends on how fast the
    // OS hands us frames — that decoupling is what survives the hidden-window delivery throttle.
    if (camReader) (async () => {
      try {
        for (;;) {
          const { value, done } = await camReader.read();
          if (done || pump?.stop) { value?.close(); break; }
          recFrameCam?.close();
          recFrameCam = value;
        }
      } catch (e) { logError('pump.camReader', e); }
    })();
    (async () => {
      try {
        for (;;) {
          const { value: sf, done } = await screenReader.read();
          if (done) { // the source (screen/window) track ENDED — recording can't continue past here
            logEvent('pump.screenTrack.ended', { recording, note: 'source track ended mid-record → writer will close, take stops here' });
            sf?.close(); break;
          }
          if (pump?.stop) { sf?.close(); break; }
          recFrameScreen?.close();
          recFrameScreen = sf;
        }
      } catch (e) { logError('pump.screenReader', e); }
      finally { try { await writer.close(); } catch (e) { logError('pump.writer.close', e); } }
    })();

    const stream = new MediaStream([gen]);
    if (audioTrack) stream.addTrack(audioTrack);
    return stream;
  }

  function teardownPump() {
    if (!pump) return;
    pump.stop = true;
    try { pump.screenReader.cancel(); } catch {}
    try { pump.camReader?.cancel(); } catch {}
    pump = null;
    if (recFrameScreen) { try { recFrameScreen.close(); } catch {} recFrameScreen = null; }
    if (recFrameCam) { try { recFrameCam.close(); } catch {} recFrameCam = null; }
  }

  return {
    id: 'composite',

    async activate() {
      els.preview.hidden = true;
      els.wrap.hidden = false;
      running = true;
      sizeCanvas();
      applyGrid();
      stageResize.observe(els.stageBox);
      // restore the source choices (main = screen/phone, bubble = camera/display)
      if (['screen', 'phone'].includes(localStorage.getItem('ss-main-source'))) els.mainSource.value = localStorage.getItem('ss-main-source');
      if (['camera', 'display'].includes(localStorage.getItem('ss-bubble-source'))) els.bubbleSource.value = localStorage.getItem('ss-bubble-source');
      applyBubbleSourceUi();
      // The mic first — your voice must never depend on the camera.
      try { await openMicStream(); }
      catch (e) { ctx.toast(`Microphone unavailable: ${e.message} — your voice won't be recorded`, true); }
      // The camera only if the bubble shows it (Off = camera off); a display bubble waits for Pick.
      try { await syncCamera(); }
      catch (e) { ctx.toast(`Camera for bubble unavailable: ${e.message}`, true); }
      startLoop();
      els.pick.onclick = () => pickScreen().catch((e) => ctx.toast(e.message, true));
      els.mainSource.onchange = () => localStorage.setItem('ss-main-source', els.mainSource.value);
      els.bubbleSource.onchange = () => {
        localStorage.setItem('ss-bubble-source', els.bubbleSource.value);
        applyBubbleSourceUi();
        syncCamera().catch((e) => ctx.toast(e.message, true));
      };
      els.mic.onchange = () => {
        localStorage.setItem('ss-mic', els.mic.value);
        openMicStream().catch((e) => ctx.toast(`Microphone unavailable: ${e.message}`, true));
      };
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
      els.bubblePick.onclick = () => openBubbleDisplay().catch((e) => ctx.toast(e.message, true));
      els.repickAudio.onclick = () => pickScreen().catch((e) => ctx.toast(e.message, true));
      els.callOk.onclick = () => { callAudioDismissed = true; updateCallAudioUi(); };
      els.popout.onclick = () => (pip.win ? closeMonitor() : openMonitor().catch((e) => ctx.toast(e.message, true)));
      initBackdrops(); // the gallery + the chosen backdrop (the default background on a first run)
      els.bgPick.onclick = () => els.bgInput.click();
      els.bgInput.onchange = () => {
        const file = els.bgInput.files?.[0];
        if (file) saveBackdrop(file);
        els.bgInput.value = ''; // allow re-picking the same file
      };
      els.bgClear.onclick = () => chooseBackdrop('none');
      els.winRadius.value = winRadPx;
      els.winRadiusVal.textContent = winRadPx;
      els.winRadius.oninput = () => { winRadPx = Number(els.winRadius.value); els.winRadiusVal.textContent = winRadPx; persist(); };
      els.viewReset.onclick = () => {
        view.zoom = 1; zoomTarget = 1; zoomAnchor = null;
        view.panX = 0; view.panY = 0;
        syncZoomUi();
      };
      els.zoom.oninput = () => {
        zoomTarget = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(els.zoom.value) / 100));
        const r = screenRect();
        zoomAnchor = r ? { px: (W() / 2 - r.x) / r.s, py: (H() / 2 - r.y) / r.s, cx: W() / 2, cy: H() / 2 } : null;
        zoomEls.val.textContent = `${zoomTarget.toFixed(1)}×`;
      };
      els.fit.onchange = () => {
        view.zoom = 1; zoomTarget = 1; zoomAnchor = null;
        view.panX = 0; view.panY = 0;
        syncZoomUi();
        persist();
      };
      els.lock.onclick = () => setLocked(!locked);
      els.shape.onchange = () => {
        bubble.shape = els.shape.value; clampBubble(); coverImage(); persist();
        syncCamera().catch((e) => ctx.toast(`Camera for bubble unavailable: ${e.message}`, true));
      };
      els.size.oninput = () => {
        const v = Number(els.size.value) / 100;
        const f = bubble.wF > 0 ? v / bubble.wF : 1; // how much the box scales
        bubble.hF = bubble.hF * f; // keep the box aspect (the crop shape)
        bubble.wF = v;
        const cx = bubble.xF * W(), cy = bubble.yF * H();
        clampBubble();
        scaleImageAround(f, cx, cy); // scale the image too → the crop is preserved, just resized
        snapped.cx = snapped.cy = false;
        persist();
      };
      els.radius.oninput = () => { bubble.radius = Number(els.radius.value); persist(); };
      els.borderW.oninput = () => { bubble.borderW = Number(els.borderW.value); persist(); };
      els.borderC.oninput = () => { bubble.borderColor = els.borderC.value; persist(); };
      els.pos.onchange = () => { if (els.pos.value) { applyPreset(els.pos.value); els.pos.value = ''; } };
      els.gridBtn.onclick = () => { gridOn = !gridOn; applyGrid(); persist(); };
      els.blurAdd.onclick = () => setBlurMode(!blurMode);
      els.blurClear.onclick = () => { blurs = []; setBlurMode(false); ctx.toast('Blurs cleared'); };
      // listeners live on the WORKSPACE (stage box), not just the canvas, so blur
      // drags can start outside the frame; coords still map through the canvas rect
      els.stageBox.addEventListener('pointerdown', onPointerDown);
      els.stageBox.addEventListener('pointermove', onPointerMove);
      els.stageBox.addEventListener('pointerup', onPointerUp);
      els.stageBox.addEventListener('pointercancel', onPointerUp);
      els.stageBox.addEventListener('pointerleave', onPointerLeave);
      els.stageBox.addEventListener('wheel', onWheel, { passive: false });
      document.addEventListener('keydown', onKeyDown);
      ctx.setReady(!!screenStream);
      updateCallAudioUi();
    },

    deactivate() {
      running = false;
      setBlurMode(false);
      setLocked(false);
      stageResize.disconnect();
      ctx.meter?.detach();
      els.wrap.hidden = true;
      els.preview.hidden = false;
      els.stageBox.removeEventListener('pointerdown', onPointerDown);
      els.stageBox.removeEventListener('pointermove', onPointerMove);
      els.stageBox.removeEventListener('pointerup', onPointerUp);
      els.stageBox.removeEventListener('pointercancel', onPointerUp);
      els.stageBox.removeEventListener('pointerleave', onPointerLeave);
      els.stageBox.removeEventListener('wheel', onWheel);
      els.stageBox.style.cursor = '';
      document.removeEventListener('keydown', onKeyDown);
      navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      for (const s of [screenStream, camStream, micStream]) s?.getTracks().forEach((t) => t.stop());
      screenStream = camStream = micStream = null;
      camIsDisplay = false;
      camVideo.srcObject = null;
      unlockShape();
      updateCallAudioUi(); // running is false now → hides the warning + the call meter
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
      if (stallTimer) clearInterval(stallTimer);
      teardownPump();
      if (captureTrack) { try { captureTrack.stop(); } catch {} captureTrack = null; }
      stopLoop();
      closeMonitor();
    },

    onRatioChange() { sizeCanvas(); imgRect = null; }, // canvas px changed → re-fit the image

    async start() {
      const track = screenStream?.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') {
        throw new Error('screen share has ended — choose a screen / window again');
      }
      sizeCanvas();
      setBlurMode(false);
      recording = true;
      els.wrap.classList.add('rec');
      applyGrid(); // grid is preview-only — hide it while encoding
      const audio = mixedAudioTrack();
      const composite = compositeActive();
      let stream, device;
      if (!composite) {
        // Plain screen: record the OS capture track directly — no canvas, no pump. OS-driven,
        // so it can't freeze when hidden and it's the lightest path for multi-hour tutorials
        // (the reel crop happens later in Finish).
        stream = new MediaStream([track]);
        if (audio) stream.addTrack(audio);
        device = 'screen (raw)';
      } else if (canInsertable()) {
        stream = startInsertablePump(track, audio); // freeze-proof: live source frames, no canvas capture
        device = 'screen+bubble composite';
      } else {
        // old browsers only: canvas.captureStream can freeze when the window is hidden/occluded
        const cs = els.canvas.captureStream(0);
        captureTrack = cs.getVideoTracks()[0];
        if (audio) cs.addTrack(audio);
        try { captureTrack.requestFrame(); } catch {}
        stream = cs;
        device = 'screen+bubble composite';
      }
      // A take that starts WITHOUT a visible bubble can't grow one mid-take (the camera is off, or the
      // raw path has nothing to draw on), so the shape stays put until the take ends — instead of
      // seeming to work and never reaching the file.
      const bubbleInTake = bubble.shape !== 'off' && !!camStream?.getVideoTracks().some((t) => t.readyState === 'live');
      if (!bubbleInTake) {
        els.shape.disabled = true;
        els.shape.title = 'The face bubble was off when this take started — set it before you record';
      }
      const hasMic = !!micStream?.getAudioTracks().some((t) => t.readyState === 'live');
      const hasSystemAudio = !!screenStream?.getAudioTracks().some((t) => t.readyState === 'live');
      logEvent('record-start', {
        device, composite, insertable: composite && canInsertable(), hasAudio: !!audio,
        hasMic, hasSystemAudio, bubble: bubbleInTake, ratio: ctx.getRatio(),
      });
      meta = { mode: 'screen', ratio: ctx.getRatio(), device, reel: ctx.getReel() };
      // Raw screen compresses well → 8 Mbps keeps 2-hour files disk-friendly; composite/reels stay
      // at 12 (reel spec). Override with localStorage 'ss-bitrate' (Mbps) for a specific rate.
      const bitrate = (Number(localStorage.getItem('ss-bitrate')) || (composite ? 12 : 8)) * 1_000_000;
      recorder = makeRecorder(stream, { bitrate, meta });
      await recorder.start();
      lastFrameAt = performance.now();
      if (composite) {
        stallTimer = setInterval(() => {
          const stalled = performance.now() - lastFrameAt > 800; // safety net (should not fire now)
          els.warn.hidden = !stalled;
          if (stalled) els.warn.textContent = 'Frames stalling — the recording loop stopped';
        }, 500);
      }
    },

    pause() { recorder?.pause(); },
    resume() { recorder?.resume(); },

    // Mute = your mic track goes silent. The screen, bubble and the call's system audio keep
    // recording — only your voice leaves the take, with no gap in the file.
    setMicMuted(m) { micStream?.getAudioTracks().forEach((t) => { t.enabled = !m; }); },

    // retake: throw the take away; streams stay live for the re-roll
    async cancel() {
      recording = false;
      unlockShape();
      els.wrap.classList.remove('rec');
      applyGrid();
      if (stallTimer) { clearInterval(stallTimer); els.warn.hidden = true; }
      if (recorder) {
        if (recorder.streaming) await recorder.abort().catch(() => {});
        else await recorder.stop().catch(() => {});
      }
      teardownPump();
      recorder = null;
      if (captureTrack) { try { captureTrack.stop(); } catch {} captureTrack = null; }
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
      syncCamera().catch(() => {}); // bubble set to Off mid-take → the camera goes off now
    },

    async stop() {
      recording = false;
      unlockShape();
      els.wrap.classList.remove('rec');
      applyGrid();
      if (stallTimer) { clearInterval(stallTimer); els.warn.hidden = true; }
      const streaming = recorder.streaming;
      ctx.toast('Saving…');
      const streamedTake = streaming ? await recorder.stop() : null;
      const blob = streaming ? null : await recorder.stop();
      teardownPump();
      if (captureTrack) { try { captureTrack.stop(); } catch {} captureTrack = null; }
      if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
      syncCamera().catch(() => {}); // bubble set to Off mid-take → the camera goes off now
      const take = streaming ? streamedTake : await uploadRecording(blob, { ...meta, mime: recorder.mime });
      if (els.autofinish.checked && take.status === 'raw') {
        await finishTake(take.id).catch((e) => ctx.toast(`Finish failed: ${e.message}`, true));
      }
      return take;
    },
  };
}
