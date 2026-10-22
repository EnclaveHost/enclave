#!/usr/bin/env bash
# live-run.sh - the READ-ONLY post-cutover audit, as root authorized (ROOT-CUTOVER-READY.txt): marker -> collectors -> chain
# audit -> verdict, into a NEW evidence/live-<stamp>/ directory (create-only files). Exit: accept.mjs's (0/3/1), or 2 if a
# step could not run.
#   bash live-run.sh <settingsSwappedAt ISO>
set -u
cd "$(dirname "$0")"
SWAP=${1:?settingsSwappedAt}
D=evidence/live-$(date -u +%Y%m%dT%H%M%SZ); mkdir "$D" || exit 2
echo "== marker (first Base block at or after $SWAP)"; node find-cutover-block.mjs --activated-at "$SWAP" --activate-started-at "$SWAP" --out "$D/cutover.json" || exit 2
echo "== minipc";  bash collect-minipc.sh minipc  > "$D/minipc.json";  [ -s "$D/minipc.json" ] || { echo "no minipc document"; exit 2; }
echo "== source";  bash collect-source.sh us-west > "$D/source.json";  [ -s "$D/source.json" ] || { echo "no source document"; exit 2; }
echo "== chain";   node audit-chain.mjs --cutover "$D/cutover.json" --minipc "$D/minipc.json" --out "$D/chain.json" > /dev/null; echo "chain audit exit $?"
[ -s "$D/chain.json" ] || { echo "no chain document"; exit 2; }
echo "== verdict"; node accept.mjs --cutover "$D/cutover.json" --minipc "$D/minipc.json" --source "$D/source.json" --chain "$D/chain.json" | tee "$D/verdict.txt"; e=${PIPESTATUS[0]}
echo "evidence: $D"; exit $e
