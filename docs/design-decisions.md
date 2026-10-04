# Segan Sessions — design decisions

Why the tool is shaped the way it is. Research verified against 2025–2026 sources at build time.

## Local web app, not native Swift / Tauri / a fork

- Chrome ≥126 on macOS records **real H.264/AAC MP4** via MediaRecorder (VideoToolbox HW) — the
  historical "browsers only produce webm" blocker is gone. System-audio capture works too
  (Chrome 141+ / macOS 14.2+). So a zero-build page + tiny node server covers every capture need.
- Native Swift (AVFoundation/ScreenCaptureKit) has a higher quality ceiling but 3–5× the code, and
  the Android path would still be scrcpy. Tauri adds packaging for zero capability gain over Chrome.
- Forks considered: **Cap** (AGPL, no 9:16 canvas), **Screenity** (GPLv3 Chrome ext, no 9:16),
  **Kap** (unmaintained since 2022). **Reframed** (jkuri/reframed, MIT, native 9:16 recorder) is the
  best off-the-shelf backstop — but has no Android capture and no takes manifest.
- Zero npm dependencies on purpose: Claude Code iterates fastest on plain files; nothing to break.

## Camera mode records RAW, crops later

A FaceTime-cam 9:16 crop is 608×1080 → 1080×1920 is a ~1.78× upscale either way. Recording the raw
1920×1080 stream and letting ffmpeg do the single crop/scale (lanczos) avoids a second lossy
canvas→encoder generation and keeps the full landscape original for reframing. The composite mode
must composite live (bubble), so only there does the canvas feed the encoder.

## Android = scrcpy recording, deliberately NOT a virtual webcam

- scrcpy `--video-source=camera --record` is **passthrough**: the phone encodes (H.265, up to 4K),
  the Mac just muxes — zero transcode loss, clean device timestamps. This beats any virtual-camera
  route, which on macOS would be scrcpy window → OBS window-capture → OBS Virtual Camera (adds
  latency + a screen-capture generation loss).
- scrcpy's own virtual camera sink (v4l2) is Linux-only. DroidCam has no macOS client. Samsung ships
  native USB-UVC webcam mode only from Galaxy S26 (absent on S24/S25). So for Samsung S-series,
  scrcpy over adb is the correct architecture, not a compromise.
- Record to **.mkv**, remux to .mp4 on stop: an interrupted .mp4 loses its moov atom; .mkv survives
  USB unplugs — the take is marked `status:"error"` but the bits are recoverable.
- **Real-device finding (2026-07-14, OPPO A16 / Android 11):** scrcpy camera source silently
  produces zero bytes on Android <12 — no error in stderr, the session just never receives frames.
  Mitigations shipped: `/api/phone/status` reports `androidSdk`/`cameraSupported` (SDK ≥31), the UI
  disables the camera source with an explanation, the record-status poll warns at >6 s with 0 bytes,
  and a 0-byte stop returns HTTP 422 (empty file deleted) instead of a junk manifest entry.
- Max-quality flow: shoot in the Samsung camera app (OEM processing/stabilization scrcpy's Camera2
  path can't access) → "Pull latest" adb-pulls it. scrcpy screen mirror can serve as a monitor.

## The takes manifest

`<library>/takes.json` (default `~/Movies/Segan Sessions/takes.json`), server-written only,
ffprobe-derived fields (client metadata is never trusted — webm blobs report `Infinity` duration).
Paths are relative to the library, so the whole folder can move, and an editing script or an AI
agent can act on entries directly. Atomic tmp+rename writes; an in-process queue serializes
mutations.

## Explicitly out of scope

- OBS replacement (long tutorials stay on OBS), Region/Element Capture APIs (tab-only — canvas
  compositing covers all sources), frameworks/bundlers, Android-as-webcam.
- Auto-captions: deferred. Captions belong in the edit, after the take; whisper.cpp (Metal) is the
  likely path if they ever move into the studio.
