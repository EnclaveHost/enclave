#!/usr/bin/env bash
# the host-service packages from this tree (scripts/build-host-service-packages.mjs), then which package files changed
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; cd "$HERE/repo"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin" TMPDIR="$HERE/tmp/t"; mkdir -p "$TMPDIR"
git log -1 --format='HEAD %H'
timeout -k 10 600 node scripts/build-host-service-packages.mjs
echo "== package files changed vs HEAD:"; git status --porcelain -- network/host-services/packages
