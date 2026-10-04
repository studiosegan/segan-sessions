#!/usr/bin/env bash
# Segan Sessions from a git checkout — one command: start the local server and open Chrome.
# Uses your own node + ffmpeg, or the installer's private copies if you have run it once.
set -euo pipefail
cd "$(dirname "$0")"
RUNTIME="$HOME/Library/Application Support/Segan Sessions/runtime"

command -v node >/dev/null || PATH="$RUNTIME/node/bin:$PATH"
command -v node >/dev/null || { echo "node not found — install Node.js 20+ (brew install node) or run the installer" >&2; exit 1; }
command -v ffmpeg >/dev/null || [ -x "$RUNTIME/bin/ffmpeg" ] \
  || { echo "ffmpeg not found — brew install ffmpeg, or run the installer" >&2; exit 1; }

exec node server.js --open
