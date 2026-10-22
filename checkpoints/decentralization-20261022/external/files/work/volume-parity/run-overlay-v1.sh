#!/usr/bin/env bash
# The candidate's delta on a scratch copy of CURRENT main (immutable; v1): main without .git, a REAL copy of its root
# node_modules, then overlay.py's delta (refusing if main moved under a changed file). guestd's whole suite (it needs
# the repository: ipfs_fetch, the supervisor seam) and the JS suites (supervisor gate, Windows plan and manager).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
main=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
S="$here/scratch/overlay-$$"
trap 'rm -rf "$S"' EXIT
mkdir -p "$S"
rsync -a --exclude .git --exclude node_modules --exclude 'target/' "$main/" "$S/"
cp -a "$main/node_modules" "$S/node_modules"
python3 "$here/overlay.py" "$main" "$here/tree" "$S"
export GOFLAGS="-mod=readonly -p=2" GOTOOLCHAIN=local GOMAXPROCS=4
(cd "$S/isolation/m4/guestd" && go vet ./... && go test -count=1 ./...)
cd "$S"
node --test --test-concurrency=1 \
  test/isolation-encvol-gate.test.mjs test/isolation-claim-gate.test.mjs \
  windows/vbslike/datapath/encvol-plan.test.mjs windows/vbslike/manager/protected-ports.test.mjs windows/vbslike/manager/server.test.mjs \
  test/windows-node-preclaim.test.mjs test/direct-only-supervisor.test.mjs test/bootstrap-supervisor.test.mjs
echo "run-overlay-v1: PASS"
