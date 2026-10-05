#!/bin/bash
# How many times Segan Sessions was installed and updated, per release — GitHub's download counts
# of the two install files (see tools/release.sh). Needs the GitHub CLI (gh).
#
#   tools/installs.sh
set -euo pipefail

gh api repos/studiosegan/segan-sessions/releases --paginate --jq '
  .[] | [ .tag_name,
          ([.assets[] | select(.name == "segan-sessions.tar.gz")        | .download_count] | add // 0),
          ([.assets[] | select(.name == "segan-sessions-update.tar.gz") | .download_count] | add // 0) ]
  | @tsv' |
awk -F'\t' 'BEGIN { printf "%-10s %13s %8s\n", "release", "new installs", "updates" }
            { printf "%-10s %13d %8d\n", $1, $2, $3; n += $2; u += $3 }
            END { printf "%-10s %13d %8d\n", "total", n, u }'
