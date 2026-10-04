#!/bin/bash
# Removes Segan Sessions — the app, its private tools and its settings. Your footage stays.
#
#   curl -fsSL https://raw.githubusercontent.com/studiosegan/segan-sessions/main/uninstall.sh | bash
set -euo pipefail

main() {
  local base="$HOME/Library/Application Support/Segan Sessions" app
  if [ -f "$base/server.pid" ]; then kill "$(cat "$base/server.pid")" 2>/dev/null || true; fi
  pkill -f "$base/app/server.js" 2>/dev/null || true

  # only an app this installer built (it carries a marker) — never someone else's. SEGAN_APP_DIR
  # limits it to that folder, so a test uninstall can never touch the real /Applications.
  local dirs=("/Applications" "$HOME/Applications") d
  if [ -n "${SEGAN_APP_DIR:-}" ]; then dirs=("$SEGAN_APP_DIR"); fi
  for d in "${dirs[@]}"; do
    app="$d/Segan Sessions.app"
    if [ -e "$app/Contents/Resources/segan-sessions-launcher" ]; then rm -rf "$app"; echo "Removed $app"; fi
  done
  if [ -d "$base" ]; then rm -rf "$base"; echo "Removed $base"; fi

  echo
  echo "Segan Sessions is uninstalled."
  echo "Your recordings are still in ~/Movies/Segan Sessions — delete that folder yourself if you don't need them."
}

main "$@"
