// meter.js — live mic level bar. Green = healthy, red = clipping, amber = the mic
// has been silent for 3s WHILE recording (muted / wrong mic — the #1 ruined-take cause).
export function createMicMeter(ctx) {
  const wrap = document.getElementById('mic-meter');
  const fill = document.getElementById('mic-meter-fill');
  let ac = null, raf = null, silentSince = null, warnedThisTake = false;
  let muted = false; // muted on purpose → greyed, and the "mic looks silent" warning must not nag

  function attach(stream) {
    detach();
    if (!stream?.getAudioTracks().length) return;
    wrap.hidden = false;
    ac = new AudioContext();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
      fill.style.width = `${Math.min(100, Math.round(peak * 130))}%`; // slight boost so speech fills the bar
      wrap.classList.toggle('clip', peak >= 0.98);

      if (ctx.isRecording() && !muted) {
        if (peak < 0.015) {
          silentSince ??= performance.now();
          const silent = performance.now() - silentSince > 3000;
          wrap.classList.toggle('silent', silent);
          if (silent && !warnedThisTake) {
            warnedThisTake = true;
            ctx.toast('Mic looks SILENT — check the microphone selection!', true);
          }
        } else {
          silentSince = null;
          wrap.classList.remove('silent');
        }
      } else {
        silentSince = null;
        warnedThisTake = false;
        wrap.classList.remove('silent');
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function detach() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (ac) { ac.close().catch(() => {}); ac = null; }
    wrap.hidden = true;
    wrap.classList.remove('clip', 'silent');
    fill.style.width = '0%';
  }

  function setMuted(m) { muted = m; wrap.classList.toggle('muted', m); }

  return { attach, detach, setMuted };
}

// Call-audio level: what the SHARED screen is playing — in a meeting, the other side's voice.
// Its only job is to prove the call is being captured; no silence warning, a quiet call is normal.
export function createCallMeter() {
  const wrap = document.getElementById('call-meter');
  const fill = document.getElementById('call-meter-fill');
  let ac = null, raf = null;

  function attach(stream) {
    detach();
    const tracks = stream?.getAudioTracks().filter((t) => t.readyState === 'live') || [];
    if (!tracks.length) return;
    wrap.hidden = false;
    ac = new AudioContext();
    ac.resume().catch(() => {});
    const analyser = ac.createAnalyser();
    analyser.fftSize = 1024;
    ac.createMediaStreamSource(new MediaStream(tracks)).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
      fill.style.width = `${Math.min(100, Math.round(peak * 130))}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function detach() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    if (ac) { ac.close().catch(() => {}); ac = null; }
    wrap.hidden = true;
    fill.style.width = '0%';
  }

  return { attach, detach };
}
