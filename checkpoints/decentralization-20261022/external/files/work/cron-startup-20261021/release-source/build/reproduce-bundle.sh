#!/usr/bin/env bash
# Reproduce the DEPLOYED Windows host-admission bundle from source, with the EXISTING build script, in a scratch copy.
# Proven once already (evidence/job-final.sh -> evidence/job-final.out, steps 1 and 3); this is that recipe, minus tests.
# NOT run in the packaging step. Never edits work/enclave: rsync into a scratch tree, overlay, build, compare.
#   bash build/reproduce-bundle.sh [canonical-tree]        (queue it: python3 work/claude-test-queue.py --mib 512 ...)
# Expected: baseline (canonical + config [] only) == 7ce23a55… (the pre-fix deployed bundle), final == 66c6e15a… .
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC=${1:-/home/steven/Documents/Codex/2026-10-18/wo/work/enclave}
T=$(mktemp -d "${TMPDIR:-$HERE}/repro-XXXXXX")       # on disk (TMPDIR), not /tmp tmpfs
trap 'rm -rf "$T"' EXIT
rsync -a --exclude .git --exclude node_modules "$SRC/" "$T/"
for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules windows/node/node_modules; do
  [ -d "$SRC/$nm" ] && ln -s "$SRC/$nm" "$T/$nm"; done
cd "$T"
# CAS on the three inputs: the canonical bases this package was made against
B=$(sha256sum network/host-admission-runtime.mjs network/lease-reader.mjs network/platform-host-policy-config.mjs | cut -c1-8 | tr '\n' ' ')
echo "canonical bases: $B"; [ "$B" = "b0d4d2ab d885b303 6422d065 " ] || { echo "BASE MISMATCH (expected b0d4d2ab d885b303 6422d065)"; exit 2; }
cp "$HERE/source/network/platform-host-policy-config.mjs" network/
node scripts/build-host-admission.mjs
echo "baseline $(sha256sum windows/node/host-admission.bundle.mjs | cut -d' ' -f1)   (expect 7ce23a55c9ffccf1c30c818ef3d7a6774cf3c8743fcac62a1421d11456794fc6)"
cp "$HERE/source/network/host-admission-runtime.mjs" "$HERE/source/network/lease-reader.mjs" network/
node scripts/build-host-admission.mjs
F=$(sha256sum windows/node/host-admission.bundle.mjs | cut -d' ' -f1)
echo "final    $F   (expect 66c6e15a793b8dc4cb80f209b6ffa405c40c7d235284727384e4833576610067)"
[ "$F" = 66c6e15a793b8dc4cb80f209b6ffa405c40c7d235284727384e4833576610067 ] && echo REPRODUCED || { echo NOT REPRODUCED; exit 1; }
