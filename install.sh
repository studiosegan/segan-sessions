#!/bin/bash
# Segan Sessions installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/studiosegan/segan-sessions/main/install.sh | bash
#
# Puts the studio and its own private Node.js, ffmpeg and scrcpy (+ adb) in
# ~/Library/Application Support/Segan Sessions, and the "Segan Sessions" app in /Applications.
# Nothing system-wide, no Homebrew, no password. Run it again any time to update — your footage
# in ~/Movies/Segan Sessions is never touched. Every tool download is pinned to an exact version
# and checked against its published SHA-256 before it is used.
#
# Options (environment variables):
#   SEGAN_APP_DIR=~/Applications    where the app goes (default /Applications)
#   SEGAN_REF=v1.0.0                a specific release tag or branch (default: the latest release)
#   SEGAN_SOURCE=/path/to/checkout  install from a local copy instead of GitHub (development)
#   SEGAN_NO_LAUNCH=1               don't open the app at the end
set -euo pipefail

REPO="studiosegan/segan-sessions"

NODE_VERSION="24.21.0"                     # https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
NODE_SHA_ARM64="6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe"
NODE_SHA_X64="0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299"

FFMPEG_VERSION="9.0.2"                     # static builds by Martin Riedl, https://ffmpeg.martin-riedl.de
FFMPEG_BUILD_ARM64="1789931890_9.0.2"
FFMPEG_SHA_ARM64="c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924"
FFPROBE_SHA_ARM64="fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6"
FFMPEG_BUILD_AMD64="1789931006_9.0.2"
FFMPEG_SHA_AMD64="7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4"
FFPROBE_SHA_AMD64="2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd"

SCRCPY_VERSION="4.1"                       # https://github.com/Genymobile/scrcpy/blob/v4.1/doc/macos.md
SCRCPY_SHA_AARCH64="20fd47c9014dd5e0fa77091f3cb7adbda8445a360c4584aeaa0150b5b3988ff3"
SCRCPY_SHA_X86_64="ee2a7223bc8dbdc4f482db1134bcf441178dafb833492b71ca4c22090c58ce72"

BASE="$HOME/Library/Application Support/Segan Sessions"
RUNTIME="$BASE/runtime"
LIBRARY="$HOME/Movies/Segan Sessions"

bold=$'\033[1m'; dim=$'\033[2m'; blue=$'\033[38;5;33m'; red=$'\033[31m'; yellow=$'\033[33m'; off=$'\033[0m'
step() { printf '%s==>%s %s%s%s\n' "$blue" "$off" "$bold" "$*" "$off"; }
ok()   { printf '    %s✓ %s%s\n' "$dim" "$*" "$off"; }
warn() { printf '%s!  %s%s\n' "$yellow" "$*" "$off" >&2; }
die()  { printf '%s✗  %s%s\n' "$red" "$*" "$off" >&2; exit 1; }

# Download, then refuse to use it unless the SHA-256 matches the pinned one.
fetch() {
  local url=$1 dest=$2 sha=$3 got
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --progress-bar -o "$dest" "$url" \
    || die "download failed: $url"
  got=$(shasum -a 256 "$dest" | awk '{print $1}')
  [ "$got" = "$sha" ] || die "checksum mismatch for $(basename "$url") (expected $sha, got $got) — not installing it"
}

preflight() {
  [ "$(uname -s)" = Darwin ] || die "Segan Sessions runs on macOS only."
  local ver major minor
  ver=$(sw_vers -productVersion); major=${ver%%.*}; minor=$(echo "$ver" | cut -d. -f2)
  if [ "$major" -lt 13 ] || { [ "$major" -eq 13 ] && [ "${minor:-0}" -lt 5 ]; }; then
    die "Segan Sessions needs macOS 13.5 (Ventura) or newer — this Mac has $ver."
  fi
  # hw.optional.arm64 is 1 on Apple silicon even when this shell runs under Rosetta
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; else ARCH=x86_64; fi
  ok "macOS $ver · $([ "$ARCH" = arm64 ] && echo 'Apple silicon' || echo 'Intel')"
}

install_node() {
  local dir="$RUNTIME/node" narch sha name
  if [ -x "$dir/bin/node" ] && [ "$(cat "$dir/.version" 2>/dev/null)" = "$NODE_VERSION" ]; then
    ok "Node.js $NODE_VERSION (already here)"; return
  fi
  if [ "$ARCH" = arm64 ]; then narch=arm64; sha=$NODE_SHA_ARM64; else narch=x64; sha=$NODE_SHA_X64; fi
  name="node-v$NODE_VERSION-darwin-$narch"
  step "Node.js $NODE_VERSION"
  fetch "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz" "$TMP/node.tar.xz" "$sha"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP" "$name/bin/node" "$name/LICENSE"
  rm -rf "$dir"; mkdir -p "$dir/bin"
  mv "$TMP/$name/bin/node" "$dir/bin/node"; mv "$TMP/$name/LICENSE" "$dir/LICENSE"
  echo "$NODE_VERSION" > "$dir/.version"
}

install_ffmpeg() {
  local dir="$RUNTIME/bin" farch build sha1 sha2 url
  if [ -x "$dir/ffmpeg" ] && [ -x "$dir/ffprobe" ] && [ "$(cat "$dir/.ffmpeg-version" 2>/dev/null)" = "$FFMPEG_VERSION" ]; then
    ok "ffmpeg $FFMPEG_VERSION (already here)"; return
  fi
  if [ "$ARCH" = arm64 ]; then farch=arm64; build=$FFMPEG_BUILD_ARM64; sha1=$FFMPEG_SHA_ARM64; sha2=$FFPROBE_SHA_ARM64
  else farch=amd64; build=$FFMPEG_BUILD_AMD64; sha1=$FFMPEG_SHA_AMD64; sha2=$FFPROBE_SHA_AMD64; fi
  url="https://ffmpeg.martin-riedl.de/download/macos/$farch/$build"
  step "ffmpeg $FFMPEG_VERSION"
  fetch "$url/ffmpeg.zip" "$TMP/ffmpeg.zip" "$sha1"
  fetch "$url/ffprobe.zip" "$TMP/ffprobe.zip" "$sha2"
  mkdir -p "$dir"
  unzip -o -q "$TMP/ffmpeg.zip" -d "$dir"; unzip -o -q "$TMP/ffprobe.zip" -d "$dir"
  chmod +x "$dir/ffmpeg" "$dir/ffprobe"
  echo "$FFMPEG_VERSION" > "$dir/.ffmpeg-version"
}

install_scrcpy() {
  local dir="$RUNTIME/scrcpy" sarch sha name
  if [ -x "$dir/scrcpy" ] && [ -x "$dir/adb" ] && [ "$(cat "$dir/.version" 2>/dev/null)" = "$SCRCPY_VERSION" ]; then
    ok "scrcpy $SCRCPY_VERSION + adb (already here)"; return
  fi
  if [ "$ARCH" = arm64 ]; then sarch=aarch64; sha=$SCRCPY_SHA_AARCH64; else sarch=x86_64; sha=$SCRCPY_SHA_X86_64; fi
  name="scrcpy-macos-$sarch-v$SCRCPY_VERSION"
  step "scrcpy $SCRCPY_VERSION + adb (Android phone capture)"
  fetch "https://github.com/Genymobile/scrcpy/releases/download/v$SCRCPY_VERSION/$name.tar.gz" "$TMP/scrcpy.tgz" "$sha"
  rm -rf "$dir"; mkdir -p "$dir"
  tar -xzf "$TMP/scrcpy.tgz" -C "$dir" --strip-components 1
  echo "$SCRCPY_VERSION" > "$dir/.version"
}

stop_studio() {
  if [ -f "$BASE/server.pid" ]; then kill "$(cat "$BASE/server.pid")" 2>/dev/null || true; rm -f "$BASE/server.pid"; fi
  pkill -f "$BASE/app/server.js" 2>/dev/null || true
}

install_app() {
  local new="$BASE/app.new" ref asset code
  rm -rf "$new"; mkdir -p "$new"
  if [ -n "${SEGAN_SOURCE:-}" ]; then
    step "Segan Sessions (from $SEGAN_SOURCE)"
    (cd "$SEGAN_SOURCE" && tar -cf - --exclude .git --exclude node_modules .) | tar -xf - -C "$new"
  else
    ref="${SEGAN_REF:-}"
    if [ -z "$ref" ]; then
      # The latest release's tag, read from GitHub's web redirect. Not the REST API: it allows 60
      # calls an hour per IP, and many home and mobile networks put a whole area behind one IP.
      ref=$(curl -fsSI --connect-timeout 20 "https://github.com/$REPO/releases/latest" 2>/dev/null \
        | tr -d '\r' | sed -n 's#^[Ll]ocation: .*/releases/tag/##p' | head -1 || true)
    fi
    ref="${ref:-main}"
    # The install counter: each release carries the app as two identical files, one fetched by new
    # installs and one by updates, and GitHub counts every download of a release file. That number
    # is all anyone learns — nothing inside the app reports anything.
    asset="segan-sessions.tar.gz"
    [ -f "$BASE/app/server.js" ] && asset="segan-sessions-update.tar.gz"
    step "Segan Sessions $ref"
    code=000
    case "$ref" in
      v[0-9]*) code=$(curl -L --retry 3 --connect-timeout 20 --progress-bar -o "$TMP/app.tgz" -w '%{http_code}' \
                 "https://github.com/$REPO/releases/download/$ref/$asset" || true) ;;
    esac
    if [ "$code" != 200 ]; then
      # a branch, or a release without those files: the plain source archive instead
      curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$TMP/app.tgz" \
        "https://codeload.github.com/$REPO/tar.gz/$ref" || die "couldn't download Segan Sessions ($ref)"
    fi
    tar -xzf "$TMP/app.tgz" -C "$new" --strip-components 1 || die "couldn't unpack Segan Sessions ($ref)"
  fi
  [ -f "$new/server.js" ] || die "that download doesn't contain the studio (no server.js)"
  rm -rf "$new/test" "$new/tools" "$new/docs" "$new/.github"   # dev-only; the studio never reads them
  stop_studio                                                    # an update must not leave the old one serving
  rm -rf "$BASE/app.old"
  [ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.old"
  mv "$new" "$BASE/app"
  rm -rf "$BASE/app.old"
  ok "version $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$BASE/app/package.json" | head -1)"
}

install_launcher() {
  local dir="${SEGAN_APP_DIR:-/Applications}" rc=0
  if [ -z "${SEGAN_APP_DIR:-}" ] && [ ! -w /Applications ]; then dir="$HOME/Applications"; fi
  step "The Segan Sessions app"
  bash "$BASE/app/launcher/build-app.sh" "$dir" >/dev/null || rc=$?
  if [ "$rc" = 3 ] && [ -z "${SEGAN_APP_DIR:-}" ]; then
    warn "Another \"Segan Sessions.app\" (not from this installer) is in $dir — putting yours in ~/Applications instead."
    dir="$HOME/Applications"; rc=0
    bash "$BASE/app/launcher/build-app.sh" "$dir" >/dev/null || rc=$?
  fi
  [ "$rc" = 0 ] || die "couldn't build the app in $dir"
  APP_PATH="$dir/Segan Sessions.app"
  ok "$APP_PATH"
  # One app only: a copy this installer made earlier in the other Applications folder goes. Never
  # with SEGAN_APP_DIR (a test install must not touch the real /Applications).
  if [ -z "${SEGAN_APP_DIR:-}" ]; then
    local other
    for other in "/Applications/Segan Sessions.app" "$HOME/Applications/Segan Sessions.app"; do
      if [ "$other" != "$APP_PATH" ] && [ -e "$other/Contents/Resources/segan-sessions-launcher" ]; then
        rm -rf "$other" && ok "removed the older copy in $(dirname "$other")"
      fi
    done
  fi
}

main() {
  printf '\n%sSegan Sessions%s — free vertical-video studio · github.com/%s\n\n' "$bold" "$off" "$REPO"
  preflight
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$RUNTIME" "$LIBRARY"
  install_node
  install_ffmpeg
  install_scrcpy
  install_app
  install_launcher

  if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
    warn "Segan Sessions runs in Google Chrome, which isn't on this Mac. Get it free: https://www.google.com/chrome/"
  fi

  printf '\n%s✓ Segan Sessions is installed.%s\n' "$bold" "$off"
  printf '    App       %s   (drag it to your Dock)\n' "$APP_PATH"
  if [ -f "$BASE/config.json" ]; then printf '    Footage   where your config.json says\n'
  else printf '    Footage   ~/Movies/Segan Sessions\n'; fi
  printf '    Update    run the same command again\n'
  printf '    Remove    curl -fsSL https://raw.githubusercontent.com/%s/main/uninstall.sh | bash\n\n' "$REPO"
  printf 'First run: Chrome asks for your camera, microphone and screen — click Allow.\n\n'

  if [ -z "${SEGAN_NO_LAUNCH:-}" ]; then open "$APP_PATH"; fi
}

# Everything runs from here, so a half-downloaded script (curl | bash) can never run half-way.
main "$@"
