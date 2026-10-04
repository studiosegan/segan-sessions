// teleprompter.js — floating glass card, top-center by default so the reader's
// eyes stay next to the camera. Draggable by its header, three widths, play /
// restart on the card, space to play/pause. Reads any .md/.txt in the Scripts folder of your
// footage library (Bangla and other complex scripts shape correctly in Chrome).
import { getScripts, getScript } from './api.js';

const STORE_KEY = 'ss-prompter-v1';

export function createTeleprompter(ctx) {
  const els = {
    card: document.getElementById('prompter'),
    head: document.getElementById('prompter-head'),
    title: document.getElementById('prompter-title'),
    scroll: document.getElementById('prompter-scroll'),
    view: document.querySelector('.prompter-view'),
    select: document.getElementById('sel-script'),
    pace: document.getElementById('sel-pace'),
    speed: document.getElementById('rng-speed'),
    size: document.getElementById('rng-fontsize'),
    play: document.getElementById('prompter-play'),
    restart: document.getElementById('prompter-restart'),
    recenter: document.getElementById('prompter-recenter'),
    widthBtns: [...document.querySelectorAll('.pbtn-w')],
    resize: document.getElementById('prompter-resize'),
    power: document.getElementById('btn-prompter-power'),
    stageBox: document.getElementById('stage-box'),
  };
  let playing = false, offset = 0, lastT = 0, raf = null;

  // ---- persisted layout ----
  let saved;
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
  let widthMode = saved.width || 'm';
  let customPos = saved.pos || null;   // {leftF, topF} as fractions of the stage box
  let customSize = saved.size || null; // {w, h} px — set by the corner resize handle
  let enabled = saved.on !== false;    // on/off switch — keeps the script selected while hidden
  if (saved.fontSize) els.size.value = saved.fontSize;
  if (saved.speed) els.speed.value = saved.speed;
  if (saved.pace && [...els.pace.options].some((o) => o.value === saved.pace)) els.pace.value = saved.pace;

  function persist() {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      width: widthMode, pos: customPos, size: customSize, on: enabled,
      fontSize: els.size.value, speed: els.speed.value, pace: els.pace.value,
      script: els.select.value, // reload with the same script next session
    }));
  }

  // px/s: manual slider, or computed so the whole script scrolls past in ~N seconds
  function pxPerSec() {
    if (els.pace.value === 'manual') return Number(els.speed.value);
    const dist = Math.max(100, els.scroll.scrollHeight - els.view.clientHeight / 2);
    return Math.max(8, dist / Number(els.pace.value));
  }

  function applyPace() {
    els.speed.disabled = els.pace.value !== 'manual';
  }

  function updateVisibility() {
    const hasScript = !!els.select.value;
    els.card.hidden = !enabled || !hasScript;
    els.power.classList.toggle('active', enabled);
    if (els.card.hidden) setPlaying(false);
  }

  function applyWidth() {
    els.card.classList.toggle('w-s', !customSize && widthMode === 's');
    els.card.classList.toggle('w-f', !customSize && widthMode === 'f');
    els.widthBtns.forEach((b) => b.classList.toggle('active', !customSize && b.dataset.width === widthMode));
    if (customSize) {
      // stage can shrink under the card (takes drawer, rail toggle) — keep it reachable
      const box = els.stageBox.getBoundingClientRect();
      els.card.style.width = `${Math.min(customSize.w, Math.max(240, box.width - 24))}px`;
      els.view.style.maxHeight = `${Math.min(customSize.h, Math.max(80, box.height * 0.85))}px`;
    } else {
      els.card.style.width = '';
      els.view.style.maxHeight = '';
    }
  }

  function applyPos() {
    if (customPos) {
      const box = els.stageBox.getBoundingClientRect();
      els.card.style.left = `${customPos.leftF * box.width}px`;
      els.card.style.top = `${customPos.topF * box.height}px`;
      els.card.style.transform = 'none';
    } else {
      els.card.style.left = ''; els.card.style.top = ''; els.card.style.transform = '';
    }
  }

  // ---- markdown → prompter text ----
  function stripMarkdown(md) {
    return md
      .replace(/```[\s\S]*?```/g, '')
      .replace(/^\|.*\|$/gm, '')          // tables
      .replace(/^#+\s*/gm, '')            // headings
      .replace(/^>\s*/gm, '')             // blockquotes
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^[-*]\s+/gm, '• ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---- scrolling ----
  function apply() {
    els.scroll.style.fontSize = `${els.size.value}px`;
    els.scroll.style.transform = `translateY(${-offset}px)`;
  }

  function tick(t) {
    if (!playing) return;
    if (lastT) {
      offset += (pxPerSec() * (t - lastT)) / 1000;
      if (offset > els.scroll.scrollHeight) setPlaying(false);
    }
    lastT = t;
    apply();
    raf = requestAnimationFrame(tick);
  }

  function setPlaying(p) {
    playing = p;
    els.play.classList.toggle('playing', p); // CSS swaps ▶/⏸ (svg.hidden is a no-op)
    lastT = 0;
    if (raf) cancelAnimationFrame(raf);
    if (p) raf = requestAnimationFrame(tick);
  }

  // ---- drag (by the header, buttons excluded) ----
  let dragStart = null;
  els.head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pbtn')) return;
    const card = els.card.getBoundingClientRect();
    dragStart = { dx: e.clientX - card.left, dy: e.clientY - card.top };
    els.head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.head.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const box = els.stageBox.getBoundingClientRect();
    const card = els.card.getBoundingClientRect();
    let left = e.clientX - dragStart.dx - box.left;
    let top = e.clientY - dragStart.dy - box.top;
    left = Math.max(8, Math.min(box.width - card.width - 8, left));
    top = Math.max(8, Math.min(box.height - 48, top));
    customPos = { leftF: left / box.width, topF: top / box.height };
    applyPos();
  });
  const endDrag = () => { if (dragStart) { dragStart = null; persist(); } };
  els.head.addEventListener('pointerup', endDrag);
  els.head.addEventListener('pointercancel', endDrag);

  // ---- corner resize (drag the little handle to scale the card) ----
  let resizeStart = null;
  els.resize.addEventListener('pointerdown', (e) => {
    const card = els.card.getBoundingClientRect();
    const view = els.view.getBoundingClientRect();
    resizeStart = { x: e.clientX, y: e.clientY, w: card.width, h: view.height };
    // dragging by the corner must not recenter the card — pin its current position
    if (!customPos) {
      const box = els.stageBox.getBoundingClientRect();
      customPos = { leftF: (card.left - box.left) / box.width, topF: (card.top - box.top) / box.height };
      applyPos();
    }
    els.resize.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.resize.addEventListener('pointermove', (e) => {
    if (!resizeStart) return;
    const box = els.stageBox.getBoundingClientRect();
    customSize = {
      w: Math.round(Math.min(box.width - 24, Math.max(280, resizeStart.w + (e.clientX - resizeStart.x)))),
      h: Math.round(Math.min(box.height * 0.85, Math.max(90, resizeStart.h + (e.clientY - resizeStart.y)))),
    };
    applyWidth();
  });
  const endResize = () => { if (resizeStart) { resizeStart = null; persist(); } };
  els.resize.addEventListener('pointerup', endResize);
  els.resize.addEventListener('pointercancel', endResize);

  // ---- manual scroll (wheel / trackpad, or drag the text like a phone) ----
  function nudge(dy) {
    offset = Math.max(0, Math.min(els.scroll.scrollHeight, offset + dy));
    apply();
  }
  els.view.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation(); // the canvas pan/zoom underneath must not see this
    nudge(e.deltaY);
  }, { passive: false });
  let scrub = null;
  els.view.addEventListener('pointerdown', (e) => {
    scrub = { y: e.clientY };
    els.view.setPointerCapture(e.pointerId);
    e.preventDefault(); // no text selection while scrubbing
  });
  els.view.addEventListener('pointermove', (e) => {
    if (!scrub) return;
    nudge(scrub.y - e.clientY);
    scrub.y = e.clientY;
  });
  const endScrub = () => { scrub = null; };
  els.view.addEventListener('pointerup', endScrub);
  els.view.addEventListener('pointercancel', endScrub);

  // ---- controls ----
  els.play.addEventListener('click', () => setPlaying(!playing));
  els.restart.addEventListener('click', () => { offset = 0; apply(); });
  els.recenter.addEventListener('click', () => { customPos = null; customSize = null; applyPos(); applyWidth(); persist(); });
  els.power.addEventListener('click', () => { enabled = !enabled; updateVisibility(); persist(); });
  els.widthBtns.forEach((b) => b.addEventListener('click', () => {
    widthMode = b.dataset.width; customSize = null; applyWidth(); persist();
  }));
  els.size.addEventListener('input', () => { apply(); persist(); });
  els.speed.addEventListener('change', persist);
  els.pace.addEventListener('change', () => { applyPace(); persist(); });
  window.addEventListener('resize', applyPos);
  // the stage box also resizes WITHOUT a window resize (takes drawer, sidebar toggle)
  new ResizeObserver(() => { if (!els.card.hidden) { applyPos(); applyWidth(); } }).observe(els.stageBox);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !els.card.hidden &&
        !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      setPlaying(!playing);
    }
  });

  // ---- script loading ----
  async function loadList() {
    try {
      fillList(await getScripts());
      if (saved.script && [...els.select.options].some((o) => o.value === saved.script)) {
        els.select.value = saved.script;
        els.select.dispatchEvent(new Event('change'));
      }
    } catch { /* no scripts is fine */ }
  }
  function fillList(scripts) {
    const keep = els.select.value;
    while (els.select.options.length > 1) els.select.remove(1); // option 0 is "none"
    for (const s of scripts) {
      const o = document.createElement('option');
      o.value = s.slug;
      o.textContent = s.slug;
      els.select.appendChild(o);
    }
    if ([...els.select.options].some((o) => o.value === keep)) els.select.value = keep;
  }
  // A script dropped into the Scripts folder shows up the next time you open the list — no reload.
  els.select.addEventListener('focus', () => { getScripts().then(fillList).catch(() => {}); });

  els.select.addEventListener('change', async () => {
    if (!els.select.value) {
      updateVisibility();
      ctx.setReelDefault(null);
      persist();
      return;
    }
    try {
      const md = await getScript(els.select.value);
      els.scroll.textContent = stripMarkdown(md);
      els.title.textContent = els.select.value;
      offset = 0;
      apply();
      updateVisibility();
      applyWidth();
      applyPos();
      ctx.setReelDefault(els.select.value); // recordings tag themselves with the reel
      persist();
    } catch (e) { ctx.toast(e.message, true); }
  });

  applyWidth();
  applyPace();
  updateVisibility();
  loadList();

  return {
    setPlaying,
    // called by the transport: rewind + roll with the take, stop with it
    onRecordStart() {
      if (els.card.hidden) return;
      offset = 0;
      apply();
      setPlaying(true);
    },
    onRecordStop() {
      setPlaying(false);
    },
  };
}
