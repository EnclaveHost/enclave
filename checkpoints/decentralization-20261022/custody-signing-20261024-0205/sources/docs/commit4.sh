#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
HOOKS=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo/.githooks
[ "$(git rev-parse --short=7 HEAD)" = c571a3f ]
git add ROLLBACK.md CURRENT-STATE.md SOURCES.md commit4.sh logs/commit-3.out logs/commit-3.rc logs/rangescan-3.out logs/rangescan-3.rc logs/scan-4.out logs/scan-4.rc logs/scan-gitleaks.json
git -c core.hooksPath=$HOOKS commit -q -m "Timestamps: rollback-review headers to the measured 22:29Z (were estimated 22:35Z); known-state read time ~22:28Z"
git log --format='%H %s' -1
