# Segan Sessions — notes for contributors and coding agents

A local recording studio for vertical video on macOS: a zero-dependency Node server (`server.js`,
`lib/`) plus a plain ES-module page (`public/`), driven in Chrome. No framework, no bundler, no build
step. `README.md` is the user-facing story; this file is how the code is held together.

## Layout

| Path | What |
|---|---|
| `server.js` | HTTP server on 127.0.0.1 only: static UI, streaming record API, takes, phone, backdrop, log |
| `lib/` | `manifest.js` (single writer of `takes.json`), `ffmpeg.js`, `phone.js` (adb + scrcpy), `util.js` |
| `public/` | the app. `js/composite.js` = Screener, `js/recorder.js` = streaming MediaRecorder |
| `public/backgrounds/` | the 12 shipped backdrops (generated — never hand-edit, see below) |
| `samples/Scripts/` | copied into a new library's Scripts folder on first run |
| `launcher/` | the Dock app: AppleScript + `build-app.sh` (+ prebuilt `AppIcon.icns`) |
| `install.sh`, `uninstall.sh` | the one-line installer and its undo |
| `test/` | end-to-end tests in headless Chromium against the real server |
| `tools/` | `backgrounds/` (the generator) and `screenshots/` (README images) |
| `docs/` | `design-decisions.md` (why it is built this way), README images |

## Where things live at runtime

- **Footage** — `SEGAN_LIBRARY`, default `~/Movies/Segan Sessions/`: `Camera/ Screen/ Phone/ Images/
  Scripts/` + `takes.json`. Take paths in the manifest are relative to the library.
- **App state** — `SEGAN_DATA`, default `~/Library/Application Support/Segan Sessions/data/`: the
  custom backdrop, phone thumbnails, `segan-session.log`.
- **`config.json`** (optional, `~/Library/Application Support/Segan Sessions/`, or `SEGAN_CONFIG`) —
  `library`, `folders.{camera,screen,phone,images,scripts}`, `takes`; paths are relative to
  `library` unless they start with `/` or `~`. Read once at startup. `SEGAN_LIBRARY` beats it and
  means the default layout in that folder. "Open folder" opens the folder holding the takes list.
- **Installed copy** — `~/Library/Application Support/Segan Sessions/{app,runtime}`. `server.js`
  prepends `runtime/bin` and `runtime/scrcpy` to PATH when they exist, so the installed studio
  never depends on Homebrew.

## Rules that keep it working

- **License: PolyForm Perimeter 1.0.0 — source-available, NOT "open source".** Free for any use,
  including paid client work; nobody may offer a competing product made from it (a rebrand counts),
  even free. Never describe it as open source; say "free, and the code is public". Contributions are
  accepted on the README's terms (Studio Segan may use them under any license).

- **Zero runtime npm dependencies.** Node built-ins only. Playwright is a dev dependency for tests.
- **Bind 127.0.0.1 only.** Localhost is a secure context for camera APIs, and nothing reaches the LAN.
- **Recordings stream to disk** as `<file>.part` while recording, are finalized on stop, and are
  recovered automatically after a crash (`watchOrphans`, `recoverOrphans`). Never buffer a take in
  browser memory.
- **`takes.json` has one writer** — `lib/manifest.js` (atomic tmp+rename, serialized queue).
- **The installer pins every tool** to an exact version and SHA-256. To bump Node, FFmpeg or scrcpy,
  change the version, URL and both architectures' hashes together, taking the hashes from the
  project's own published list, then re-run the sandbox check below.
- **Tests never touch real footage** — they run the server against throwaway `SEGAN_LIBRARY` and
  `SEGAN_DATA` directories.

## Checks before a release

```bash
npm install && npm test          # all 9 runs green

# the installer on a blank account with no Homebrew, from this checkout
SB=$(mktemp -d)
env -i HOME="$SB" PATH=/usr/bin:/bin:/usr/sbin:/sbin SEGAN_SOURCE="$PWD" \
  SEGAN_APP_DIR="$SB/Applications" SEGAN_NO_LAUNCH=1 bash install.sh

# the test suite on that install's private runtime
S="$SB/Library/Application Support/Segan Sessions"
env -i HOME="$SB" TMPDIR="$TMPDIR" PATH="$S/runtime/bin:$S/runtime/scrcpy:/usr/bin:/bin:/usr/sbin:/sbin" \
  PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" "$S/runtime/node/bin/node" test/run-all.mjs

# and the uninstaller — ALWAYS with SEGAN_APP_DIR: without it, it cleans the real /Applications
env -i HOME="$SB" PATH=/usr/bin:/bin:/usr/sbin:/sbin SEGAN_APP_DIR="$SB/Applications" bash uninstall.sh
```

Releases are git tags (`v1.2.0`) with a GitHub Release. The installer installs the latest release, or
`main` when none exists. Bump `version` in `package.json` with the tag — the app shows it in the footer.

## Backgrounds and screenshots

The backdrops are drawn in code with fixed seeds: `tools/backgrounds/backgrounds.html` (open it in
Chrome to preview), written out by `npm run backgrounds` (3840 px WebP plus thumbnails plus
`backgrounds.json`). To add one, add an entry to `BACKGROUNDS` there and re-render; the Screener
gallery picks it up from `backgrounds.json`. `node tools/screenshots/take.mjs` regenerates the README
images from the real app.
