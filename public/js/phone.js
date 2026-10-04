// phone.js — Mode 3: Android over USB. The server drives adb/scrcpy; the scrcpy
// window on the desktop is the live monitor. Two things live here now:
//   • Mirror & control (no recording) — a monitor window you drive with the mouse,
//     also the source Screen+Face captures as the "phone camera".
//   • Record phone SCREEN + Pull latest — screen demos, and max-quality camera
//     footage shot in the phone's own camera app. (scrcpy's raw camera source was
//     dropped: no zoom control and it cooks the phone.)
import * as api from './api.js';

export function createPhoneMode(ctx) {
  const els = {
    stage: document.getElementById('phone-stage'),
    stageTitle: document.getElementById('phone-stage-title'),
    stageSub: document.getElementById('phone-stage-sub'),
    preview: document.getElementById('preview'),
    status: document.getElementById('phone-status'),
    setup: document.getElementById('phone-setup'),
    controls: document.getElementById('phone-controls'),
    mirror: document.getElementById('btn-phone-mirror'),
    wireless: document.getElementById('btn-phone-wireless'),
    wirelessHint: document.getElementById('phone-wireless-hint'),
    pull: document.getElementById('btn-phone-pull'),
    picker: document.getElementById('pull-picker'),
    pickerList: document.getElementById('picker-list'),
    pickerTabs: document.getElementById('picker-tabs'),
    pickerAll: document.getElementById('picker-all'),
    pickerCount: document.getElementById('picker-count'),
    pickerStatus: document.getElementById('picker-status'),
    pickerPull: document.getElementById('picker-pull'),
    pickerClose: document.getElementById('picker-close'),
    pickerWhen: document.getElementById('picker-when'),
    pickerProg: document.getElementById('picker-prog'),
    pickerBar: document.getElementById('picker-bar'),
    pickerProgText: document.getElementById('picker-prog-text'),
  };
  let pollTimer = null, recPollTimer = null, recording = false;

  // ---- phone media picker: browse the camera roll, tick several, pull them all ----
  let media = [];                 // everything on the phone (both kinds)
  let kind = 'video';             // active tab
  let days = 0;                   // time filter: 0 = all, else last N days
  let thumbObs = null;            // lazy-loads thumbnails only for tiles you actually scroll to
  const picked = new Set();       // remote paths ticked, kept across tab switches

  const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB`
    : n >= 1048576 ? `${Math.round(n / 1048576)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`); // a 119 KB photo read "0 MB" before
  const when = (ms) => new Date(ms).toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  function visibleRows() {
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    return media.filter((m) => m.kind === kind && m.mtime >= cutoff);
  }

  function renderPicker() {
    const rows = visibleRows();
    // thumbnails are fetched one tile at a time as they scroll into view — fetching 126 up front
    // would queue 126 adb transfers for files you may never look at
    if (thumbObs) thumbObs.disconnect();
    thumbObs = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
        obs.unobserve(img);
      }
    }, { root: els.pickerList, rootMargin: '250px' });

    els.pickerList.className = 'picker-list grid';
    els.pickerList.innerHTML = '';
    if (!rows.length) {
      els.pickerList.className = 'picker-list';
      els.pickerList.innerHTML = `<div class="picker-empty">No ${kind}s${days ? ` in the last ${days} day${days > 1 ? 's' : ''}` : ''}.</div>`;
      syncPickerFooter();
      return;
    }
    for (const m of rows) {
      const tile = document.createElement('label');
      tile.className = `tile${picked.has(m.remote) ? ' sel' : ''}`;
      const src = `/api/phone/thumb?path=${encodeURIComponent(m.remote)}&size=${m.size}&sig=${m.mtime}`;
      tile.innerHTML = `
        <input type="checkbox" ${picked.has(m.remote) ? 'checked' : ''}>
        ${m.pulled ? '<span class="badge-pulled">pulled</span>' : ''}
        <div class="tile-img"><img alt="" data-src="${src}"></div>
        <div class="tile-meta">
          <span class="tile-name" title="${m.name}">${m.name}</span>
          <span class="tile-sub">${mb(m.size)} · ${when(m.mtime)}</span>
        </div>`;
      const img = tile.querySelector('img');
      // a thumbnail can legitimately fail (odd codec, file mid-write) — show a glyph, never a broken icon
      img.onerror = () => {
        img.remove();
        tile.querySelector('.tile-img').innerHTML = `<span class="ph">${m.kind === 'video' ? '🎬' : '🖼'}</span>`;
      };
      tile.querySelector('input').onchange = (e) => {
        if (e.target.checked) picked.add(m.remote); else picked.delete(m.remote);
        tile.classList.toggle('sel', e.target.checked);
        syncPickerFooter();
        els.pickerAll.checked = visibleRows().every((r) => picked.has(r.remote));
      };
      els.pickerList.appendChild(tile);
      thumbObs.observe(img);
    }
    els.pickerAll.checked = rows.length > 0 && rows.every((m) => picked.has(m.remote));
    syncPickerFooter();
  }

  function syncPickerFooter() {
    const n = picked.size;
    els.pickerCount.textContent = `${visibleRows().length} ${kind}s · ${n} selected`;
    els.pickerPull.disabled = n === 0;
    els.pickerPull.textContent = n ? `Pull selected (${n})` : 'Pull selected';
  }

  async function openPicker() {
    picked.clear();
    els.picker.hidden = false;
    els.pickerList.innerHTML = '<div class="picker-empty">Reading the camera roll…</div>';
    els.pickerStatus.textContent = 'Videos go to your Takes list · photos go to the Images folder (🖼 Images button)';
    try {
      media = (await api.phoneMedia()).items || [];
      renderPicker();
    } catch (e) {
      els.pickerList.innerHTML = `<div class="picker-empty">Couldn't read the phone: ${e.message}</div>`;
    }
  }

  function closePicker() { els.picker.hidden = true; }

  // Poll the server while a pull runs so the bar shows real bytes, not a guess. Speed is measured
  // between samples (not averaged from the start) so it reflects what the link is doing right now.
  function startProgressPolling() {
    let last = null;
    els.pickerProg.hidden = false;
    els.pickerStatus.textContent = '';
    els.pickerBar.style.width = '0%';
    els.pickerProgText.textContent = 'starting…';
    return setInterval(async () => {
      let p;
      try { p = await api.phonePullProgress(); } catch { return; }
      if (!p || !p.active) return;
      const done = (p.doneBytes || 0) + (p.fileBytes || 0);
      const total = p.totalBytes || 0;
      const pct = total ? Math.min(100, (done / total) * 100) : 0;
      els.pickerBar.style.width = `${pct.toFixed(1)}%`;
      let speed = '';
      if (last && done > last.done) {
        const bps = (done - last.done) / ((Date.now() - last.t) / 1000);
        if (bps > 0) {
          const left = total > done ? (total - done) / bps : 0;
          speed = ` · ${(bps / 1048576).toFixed(1)} MB/s · ${left > 90 ? `${Math.round(left / 60)}m` : `${Math.round(left)}s`} left`;
        }
      }
      last = { done, t: Date.now() };
      els.pickerProgText.textContent =
        `${Math.round(pct)}% · file ${(p.index || 0) + 1}/${p.total}${speed}`;
    }, 700);
  }

  async function pullPicked() {
    const items = media.filter((m) => picked.has(m.remote)).map((m) => ({ path: m.remote, size: m.size }));
    // one pull at a time: a second click mid-transfer is exactly how you'd corrupt a half-written file
    els.pickerPull.disabled = true;
    els.pickerAll.disabled = true;
    els.pickerPull.textContent = 'Pulling…';
    const timer = startProgressPolling();
    try {
      const r = await api.phonePull(items, ctx.getReel());
      const failed = r.results.filter((x) => !x.ok);
      ctx.toast(failed.length
        ? `Pulled ${r.pulled}, ${failed.length} failed: ${failed[0].error}`
        : `Pulled ${r.pulled} file${r.pulled > 1 ? 's' : ''} ✓`, failed.length > 0);
      ctx.refreshTakes();
      if (!failed.length) closePicker();
    } catch (e) {
      els.pickerStatus.textContent = `Failed: ${e.message}`;
      ctx.toast(e.message, true);
    } finally {
      clearInterval(timer);
      els.pickerProg.hidden = true;
      els.pickerStatus.textContent = 'Videos go to your Takes list · photos go to the Images folder (🖼 Images button)';
      els.pickerPull.disabled = false;
      els.pickerAll.disabled = false;
      syncPickerFooter();
    }
  }

  els.pickerClose.onclick = closePicker;
  els.picker.onclick = (e) => { if (e.target === els.picker) closePicker(); }; // click the backdrop
  els.pickerPull.onclick = pullPicked;
  els.pickerAll.onchange = (e) => {
    for (const m of visibleRows()) {
      if (e.target.checked) picked.add(m.remote); else picked.delete(m.remote);
    }
    renderPicker();
  };
  els.pickerWhen.onclick = (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    days = Number(b.dataset.days);
    [...els.pickerWhen.children].forEach((c) => c.classList.toggle('on', c === b));
    renderPicker();
  };
  els.pickerTabs.onclick = (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    kind = b.dataset.kind;
    [...els.pickerTabs.children].forEach((c) => c.classList.toggle('on', c === b));
    renderPicker();
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.picker.hidden) closePicker(); });

  async function poll() {
    let s;
    try { s = await api.phoneStatus(); } catch { return; }
    ctx.setPhonePill(s);
    if (!s.installed) {
      els.status.textContent = 'scrcpy / adb not installed';
      els.status.className = 'phone-status';
      els.setup.hidden = false;
      els.controls.hidden = true;
      els.stageTitle.textContent = 'Set up phone capture';
      els.stageSub.innerHTML = 'Run the Segan Sessions installer again (it brings scrcpy + adb), then plug the phone in.';
      ctx.setReady(false);
    } else if (!s.connected) {
      els.status.textContent = 'no phone detected';
      els.status.className = 'phone-status';
      els.setup.hidden = true;
      els.controls.hidden = true;
      els.stageTitle.textContent = 'No phone connected';
      els.stageSub.innerHTML = 'Plug in via USB with USB debugging on — Settings → About phone → tap <b>Build number</b> 7×, then Developer options → <b>USB debugging</b>, and tap <b>Allow</b> on the phone.<br>“Mirror &amp; control” opens your live monitor window.';
      ctx.setReady(false);
    } else if (!s.authorized) {
      els.status.textContent = `${s.model || 'phone'} found — tap “Allow USB debugging” on the phone`;
      els.status.className = 'phone-status';
      els.setup.hidden = true;
      els.controls.hidden = true;
      els.stageTitle.textContent = 'Waiting for permission';
      els.stageSub.textContent = 'Accept the USB debugging prompt on the phone screen.';
      ctx.setReady(false);
    } else {
      els.status.textContent = `connected: ${s.model || s.serial}${s.androidVersion ? ` · Android ${s.androidVersion}` : ''}`;
      els.status.className = 'phone-status ok';
      els.setup.hidden = true;
      els.controls.hidden = false;
      if (!recording) {
        els.stageTitle.textContent = s.model || 'Phone ready';
        els.stageSub.innerHTML =
          '<b>Mirror</b> a live window · <b>Record</b> the phone screen · or shoot in the camera app and <b>Pull latest</b>.';
      }
      ctx.setReady(true);
    }
  }

  async function refreshMirrorBtn() {
    try {
      const { open } = await api.phoneMirrorStatus();
      els.mirror.textContent = open ? 'Close mirror' : 'Mirror & control';
      els.mirror.classList.toggle('active', open);
    } catch { /* ignore */ }
  }

  async function refreshWirelessBtn() {
    try {
      const { wireless, address } = await api.phoneWirelessStatus();
      // keep the label short (no long IP → no overflow); the address lives in the tooltip + hint
      els.wireless.textContent = wireless ? '📶 Wireless — tap to disconnect' : '📶 Go wireless';
      els.wireless.title = wireless ? address : '';
      els.wireless.classList.toggle('active', wireless);
      if (wireless) els.wirelessHint.innerHTML = `<b>Wireless ✓</b> Unplug USB now — replug only to Pull latest. <span class="mono">${address}</span>`;
    } catch { /* ignore */ }
  }

  return {
    id: 'phone',

    async activate() {
      els.preview.hidden = true;
      els.stage.hidden = false;
      await poll();
      await refreshMirrorBtn();
      await refreshWirelessBtn();
      pollTimer = setInterval(() => { poll(); refreshWirelessBtn(); }, 3000);

      els.mirror.onclick = async () => {
        els.mirror.disabled = true;
        try {
          const { open } = await api.phoneMirrorStatus();
          if (open) { await api.phoneMirrorStop(); ctx.toast('Mirror window closed'); }
          else { await api.phoneMirrorStart(); ctx.toast('Mirror open — drive the phone with your mouse'); }
        } catch (e) { ctx.toast(e.message, true); }
        finally { els.mirror.disabled = false; refreshMirrorBtn(); }
      };

      els.wireless.onclick = async () => {
        els.wireless.disabled = true;
        const orig = els.wireless.textContent;
        try {
          const { wireless } = await api.phoneWirelessStatus();
          if (wireless) { await api.phoneWirelessDisconnect(); ctx.toast('Wireless disconnected'); }
          else {
            els.wireless.textContent = 'Connecting…';
            const { address } = await api.phoneWirelessConnect();
            ctx.toast(`Wireless connected at ${address} — you can unplug USB now`);
          }
        } catch (e) { ctx.toast(e.message, true); els.wireless.textContent = orig; }
        finally { els.wireless.disabled = false; refreshWirelessBtn(); poll(); }
      };

      els.pull.onclick = openPicker;
    },

    deactivate() {
      els.stage.hidden = true;
      els.preview.hidden = false;
      if (pollTimer) clearInterval(pollTimer);
      if (recPollTimer) clearInterval(recPollTimer);
    },

    // the red Record button records the phone SCREEN (app demos)
    async start() {
      await api.phoneRecordStart({ source: 'screen' });
      recording = true;
      els.stageTitle.textContent = 'Recording phone screen';
      recPollTimer = setInterval(async () => {
        try {
          const s = await api.phoneRecordStatus();
          const mb = (s.bytes / 1048576).toFixed(1);
          els.stageSub.textContent = `${s.elapsed}s — ${mb} MB — monitor is the scrcpy window`;
          if (!s.recording && recording) {
            els.stageSub.textContent = 'scrcpy window closed — press stop to finish';
          }
        } catch {}
      }, 1000);
    },

    async stop() {
      recording = false;
      if (recPollTimer) clearInterval(recPollTimer);
      ctx.toast('Finalizing phone recording…');
      const take = await api.phoneRecordStop();
      if (take.status === 'error') ctx.toast(`Saved with problems: ${take.notes}`, true);
      await poll();
      return take;
    },
  };
}
