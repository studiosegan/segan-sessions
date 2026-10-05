#!/bin/bash
# Publish a release: tag, push, and a GitHub Release carrying the two files the installer downloads.
#
#   tools/release.sh 1.2.0          bump "version" in package.json and commit first
#   NOTES="what changed" tools/release.sh 1.2.0
#
# install.sh fetches segan-sessions.tar.gz on a new install and segan-sessions-update.tar.gz on an
# update — the same archive under two names — so GitHub's per-file download counts are the install
# and update counts. tools/installs.sh prints them. Nothing inside the app reports anything.
set -euo pipefail
cd "$(dirname "$0")/.."

ver="${1:?usage: tools/release.sh <version, e.g. 1.2.0>}"
tag="v$ver"
[ -z "$(git status --porcelain)" ] || { echo "Commit everything first."; exit 1; }
grep -q "\"version\": \"$ver\"" package.json || { echo "package.json has another version; bump it to $ver first."; exit 1; }

git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git tag -a "$tag" -m "Segan Sessions $ver"
git push origin HEAD:main "$tag"

out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
git archive --format=tar.gz --prefix=segan-sessions/ -o "$out/segan-sessions.tar.gz" "$tag"
cp "$out/segan-sessions.tar.gz" "$out/segan-sessions-update.tar.gz"

if gh release view "$tag" >/dev/null 2>&1; then
  # never --clobber: re-uploading a file resets its download count
  gh release upload "$tag" "$out/segan-sessions.tar.gz" "$out/segan-sessions-update.tar.gz"
else
  gh release create "$tag" "$out/segan-sessions.tar.gz" "$out/segan-sessions-update.tar.gz" \
    --title "Segan Sessions $ver" --notes "${NOTES:-Segan Sessions $ver}" --latest
fi
echo "Released $tag — https://github.com/studiosegan/segan-sessions/releases/tag/$tag"
