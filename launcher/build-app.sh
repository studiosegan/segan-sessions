#!/bin/bash
# Builds "Segan Sessions.app" — the Dock launcher — into a folder (default /Applications).
# The installer runs this for you. From a git checkout:  launcher/build-app.sh [~/Applications]
#
# Exit 3 = a "Segan Sessions.app" this script didn't make is already there; it is never replaced.
set -eo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="$(cd "$HERE/.." && pwd)"                     # the studio this launcher starts
DEST_DIR="${1:-/Applications}"
APP="$DEST_DIR/Segan Sessions.app"
SUPPORT="$HOME/Library/Application Support/Segan Sessions"
BUNDLE_ID="com.studiosegan.segansessions"
MARK="Contents/Resources/segan-sessions-launcher"     # proves an app at $APP is ours to replace

NODE="$SUPPORT/runtime/node/bin/node"                 # the installer's private Node…
[ -x "$NODE" ] || NODE="$(command -v node || true)"   # …or yours, in a git checkout
[ -n "$NODE" ] || { echo "node not found — run the installer, or install Node.js 20+" >&2; exit 1; }
VERSION="$("$NODE" -p "require('$APP_SRC/package.json').version" 2>/dev/null || echo 1.0.0)"

if [ -e "$APP" ] && [ ! -e "$APP/$MARK" ] && [ -z "${SEGAN_FORCE:-}" ]; then
  echo "\"$APP\" exists and wasn't made by this installer — leaving it alone." >&2
  exit 3
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BUILD="$TMP/Segan Sessions.app"
sed -e "s|__APP_DIR__|$APP_SRC|g" -e "s|__NODE__|$NODE|g" -e "s|__SUPPORT__|$SUPPORT|g" \
  "$HERE/segan-sessions.applescript" > "$TMP/launcher.applescript"
# (osacompile signs its output and says so on stderr — only show that when the compile fails)
out=$(osacompile -o "$BUILD" "$TMP/launcher.applescript" 2>&1) || { echo "$out" >&2; exit 1; }

# osacompile's template ships an Assets.car with the stock AppleScript artwork, and its Info.plist
# points CFBundleIconName at it. On modern macOS CFBundleIconName WINS over CFBundleIconFile, so our
# icon would be silently ignored for the generic script scroll. Drop both; applet.icns remains.
cp "$HERE/AppIcon.icns" "$BUILD/Contents/Resources/applet.icns"
rm -f "$BUILD/Contents/Resources/Assets.car"
PLIST="$BUILD/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Delete :CFBundleIconName' "$PLIST" 2>/dev/null || true
for kv in "CFBundleIdentifier $BUNDLE_ID" "CFBundleShortVersionString $VERSION" "CFBundleName Segan Sessions"; do
  k="${kv%% *}"; v="${kv#* }"
  /usr/libexec/PlistBuddy -c "Set :$k $v" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$k string $v" "$PLIST"
done
touch "$BUILD/$MARK"

# A stable bundle identifier + a code signature are REQUIRED for macOS privacy permissions: without
# them the app is invisible to System Settings → Privacy & Security → Local Network, and macOS
# silently blocks the phone's "Go wireless" connection. An ad-hoc signature is enough for that.
xattr -cr "$BUILD" 2>/dev/null || true
codesign --force --deep --sign - "$BUILD" >/dev/null 2>&1 \
  || echo "  note: codesign failed — Go wireless may be blocked until macOS can identify the app" >&2

mkdir -p "$DEST_DIR"
rm -rf "$APP"
mv "$BUILD" "$APP"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
