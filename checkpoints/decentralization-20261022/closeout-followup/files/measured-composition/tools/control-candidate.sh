#!/usr/bin/env bash
# control-candidate.sh <dir>: a throwaway REAL copy of the reconciled candidate exactly as it is (no overlay) + work/enclave's
# node_modules, and the --check of the generated artifacts job-1 found stale or rebuilt. Shows which staleness is the
# candidate's own (pre-existing) and which the composition causes. Nothing is written outside <dir>; <dir> is removed.
set -uo pipefail
D=$1; W=/home/steven/Documents/Codex/2026-10-18/wo/work; C=$W/resume-20261021/reconciled-candidate
[ ! -e "$D" ] || { echo "$D exists"; exit 2; }
rsync -a --exclude /node_modules --exclude /metal/__pycache__ "$C/" "$D/" || exit 2
for nm in node_modules relay/node_modules network/node_modules sdk/sessions/node_modules e2e/node_modules; do cp -a "$W/enclave/$nm" "$D/$nm" || exit 2; done
cd "$D"
for s in build-custody-vendor build-host-service-packages build-mcp-guest-bundle build-host-admission build-windows-lease-runtime build-metal-lease-gas; do
  node scripts/$s.mjs --check > "$D.$s.log" 2>&1; echo "control $s --check rc=$?"; tail -2 "$D.$s.log"; done
node relay/build-network.mjs > /dev/null 2>&1 && node scripts/build-platform-api-guest-bundle.mjs --check > "$D.platform-api.log" 2>&1; echo "control build-platform-api-guest-bundle --check (after build-network) rc=$?"; tail -2 "$D.platform-api.log"
cd /; rm -rf "$D"; echo CONTROL-DONE
