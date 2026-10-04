// camera.js — Mode 1: vertical talking-head capture from any Mac webcam.
// Records the RAW 1920×1080 stream (highest quality); the crop you see in the
// guides is applied once, by ffmpeg, in the finish step.
import { makeRecorder, ensurePermission, listDevices, openCamera, fillDeviceSelect } from './recorder.js';
import { drawOverlay } from './overlay.js';
import { uploadRecording, finishTake } from './api.js';

export function createCameraMode(ctx) {
  const els = {
    preview: document.getElementById('preview'),
    overlay: document.getElementById('overlay'),
    cam: document.getElementById('sel-cam'),
    mic: document.getElementById('sel-mic'),
    refresh: document.getElementById('btn-refresh-devices'),
    autofinish: document.getElementById('chk-autofinish'),
    mirror: document.getElementById('chk-mirror'),
  };
  els.mirror.checked = localStorage.getItem('ss-mirror') !== 'off';

  function applyMirror() {
    els.preview.classList.toggle('mirrored', els.mirror.checked);
  }
  let stream = null;
  let recorder = null;
  let meta = null;
  let raf = null;
  let active = false;

  async function fillDevices() {
    const { cams, mics } = await listDevices();
    fillDeviceSelect(els.cam, cams, 'Camera', 'ss-cam');
    fillDeviceSelect(els.mic, mics, 'Microphone', 'ss-mic');
  }

  async function openStream() {
    closeStream();
    stream = await openCamera(els.cam.value, els.mic.value);
    // a reopened stream (device change) must keep the mute: a disabled track records silence
    stream.getAudioTracks().forEach((t) => { t.enabled = !ctx.isMicMuted?.(); });
    els.preview.srcObject = stream;
    els.preview.hidden = false;
    await els.preview.play().catch(() => {});
    ctx.meter?.attach(stream);
    ctx.setReady(true);
  }

  function closeStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    els.preview.srcObject = null;
  }

  function loopOverlay() {
    if (!active) return;
    drawOverlay(els.overlay, els.preview, ctx.getRatio());
    raf = requestAnimationFrame(loopOverlay);
  }

  return {
    id: 'camera',

    async activate() {
      active = true;
      els.preview.hidden = false;
      try {
        await ensurePermission();
        await fillDevices();
        await openStream();
      } catch (e) {
        ctx.setReady(false);
        ctx.toast(`Camera unavailable: ${e.message}. Allow camera + mic for this site in Chrome.`, true);
      }
      loopOverlay();
      applyMirror();
      els.mirror.onchange = () => {
        localStorage.setItem('ss-mirror', els.mirror.checked ? 'on' : 'off');
        applyMirror();
      };
      els.cam.onchange = els.mic.onchange = () => {
        localStorage.setItem('ss-cam', els.cam.value);
        localStorage.setItem('ss-mic', els.mic.value);
        openStream().catch((e) => ctx.toast(e.message, true));
      };
      els.refresh.onclick = async () => { await fillDevices(); ctx.toast('Devices refreshed'); };
      navigator.mediaDevices.addEventListener('devicechange', fillDevices);
    },

    deactivate() {
      active = false;
      if (raf) cancelAnimationFrame(raf);
      navigator.mediaDevices.removeEventListener('devicechange', fillDevices);
      ctx.meter?.detach();
      els.preview.classList.remove('mirrored');
      closeStream();
      const c = els.overlay.getContext('2d');
      c.clearRect(0, 0, els.overlay.width, els.overlay.height);
    },

    async start() {
      if (!stream) throw new Error('camera not ready');
      const track = stream.getVideoTracks()[0];
      meta = { mode: 'camera', ratio: ctx.getRatio(), device: track ? track.label : null, reel: ctx.getReel() };
      const bitrate = (Number(localStorage.getItem('ss-bitrate')) || 12) * 1_000_000; // Quality control; Auto = 12
      recorder = makeRecorder(stream, { bitrate, meta });
      await recorder.start();
    },

    pause() { recorder?.pause(); },
    resume() { recorder?.resume(); },

    // Mute = the mic track goes silent; the recording keeps rolling (no gap, same file).
    setMicMuted(m) { stream?.getAudioTracks().forEach((t) => { t.enabled = !m; }); },

    // retake: throw the take away; the camera stream stays live
    async cancel() {
      if (recorder) {
        if (recorder.streaming) await recorder.abort().catch(() => {});
        else await recorder.stop().catch(() => {});
      }
      recorder = null;
    },

    async stop() {
      let take;
      if (recorder.streaming) {
        ctx.toast('Saving…');
        take = await recorder.stop();
      } else {
        const blob = await recorder.stop();
        ctx.toast('Saving…');
        take = await uploadRecording(blob, { ...meta, mime: recorder.mime });
      }
      if (els.autofinish.checked && take.status === 'raw') {
        ctx.toast('Finishing (crop + encode)…');
        await finishTake(take.id).catch((e) => ctx.toast(`Finish failed: ${e.message}`, true));
      }
      return take;
    },
  };
}
