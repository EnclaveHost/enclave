#!/usr/bin/env bash
# The candidate's JS changes on a scratch copy of CURRENT main (immutable; v1): main without .git, a REAL copy of its
# root node_modules, then overlay.py's delta (refusing if main moved under any changed file). Runs the new and the
# neighbouring suites, then removes the scratch copy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
S="$here/scratch/overlay-js-$$"
trap 'rm -rf "$S"' EXIT
mkdir -p "$S"
rsync -a --exclude .git --exclude node_modules "$main/" "$S/"
cp -a "$main/node_modules" "$S/node_modules"
python3 "$here/overlay.py" "$main" "$here/tree" "$S"
cd "$S"
node --test --test-concurrency=1 \
  test/isolation-encvol-gate.test.mjs test/isolation-claim-gate.test.mjs \
  windows/vbslike/datapath/encvol-plan.test.mjs windows/vbslike/manager/protected-ports.test.mjs windows/vbslike/manager/server.test.mjs \
  test/windows-node-preclaim.test.mjs test/direct-only-supervisor.test.mjs test/bootstrap-supervisor.test.mjs
echo "run-js-overlay-v1: PASS"
