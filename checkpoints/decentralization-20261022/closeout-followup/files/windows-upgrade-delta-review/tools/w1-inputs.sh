#!/usr/bin/env bash
# w1 (queue 512): bundle input manifests of F 4106c311 (exact-hash reproduction required) vs the installed builds' manifests.
set -euo pipefail
. "$(dirname "$0")/env.sh"
FC=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose/candidate
X=$B/tmp/f4106; [ ! -e "$X" ] || { echo "$X exists"; exit 2; }
git clone -q --local --no-hardlinks --no-checkout "$FC" "$X"; git -C "$X" -c advice.detachedHead=false checkout -q 4106c3114dd13f39692195c182d3152efa5e212c
# REAL copies, as F's build used (cp -a): a symlink makes esbuild record the out-of-tree real path in the bundle (attempts 1-2)
for d in . network relay; do [ -d "$FC/$d/node_modules" ] && cp -a "$FC/$d/node_modules" "$X/$d/node_modules"; done
# F's exact recipe (host-services-final-compose/build-final.sh): the packages dir removed before the build, the relay network
# runtime built first (its output is gitignored), then network/build.mjs's bundles (attempt 1 skipped both: hash mismatch)
rm -rf "$X/network/host-services/packages"
(cd "$X" && node relay/build-network.mjs >/dev/null)
mkdir -p "$B/receipts/w1"; node "$B/tools/w1-inputs.mjs" "$X" "$B/receipts/w1"
rm -f "$B"/receipts/w1/*.mjs; rm -rf "$X"
n=$(grep -vc " -V stub-proof$" "$B/stub/invocations.log" || true); [ "$n" -eq 0 ] || { echo "stub invoked $n times"; exit 5; }
echo W1-OK
