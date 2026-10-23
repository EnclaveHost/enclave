#!/usr/bin/env bash
# focused.sh <commit> <tag>: a fresh REAL-copy tree of the dashboard repo at <commit> (git archive, real node_modules copy),
# plus root's reviewed tests for the two accepted patches (test-inputs/, copied unchanged from their packages) and the
# test-only multiformats oracle (public-config-read-fallback/oracle/node_modules; never imported by site/). Each file alone.
set -uo pipefail
N=$(cd "$(dirname "$0")/.." && pwd); R=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-dashboard-20261023/repo
P=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/public-config-read-fallback
C="$1"; TAG="$2"; T="$N/tree-$TAG"; OUT="$N/logs/focused-$TAG.out"
rm -rf "$T"; mkdir -p "$T"; git -C "$R" archive "$C" | tar -x -C "$T"
cp -a "$R/node_modules" "$T/node_modules"; cp -a "$P/oracle/node_modules/multiformats" "$T/node_modules/multiformats"
cp "$N"/test-inputs/*.mjs "$T/test/"
! grep -rqs "multiformats" "$T/site" || { echo "site imports the oracle"; exit 2; }
echo "tree $TAG at $(git -C "$R" rev-parse --short=9 "$C"): catalog $(sha256sum < "$T/site/js/core/catalog.js" | cut -c1-8)" > "$OUT"
cd "$T"; rc=0
for f in test/media-fallback.test.mjs test/car-verify-oracle.test.mjs test/config-deadline.test.mjs test/config-read-fallback.test.mjs \
         test/models-read-only.test.mjs test/publish-prefill-config.test.mjs test/custody-v2-dashboard.test.mjs; do
  echo "=== FILE $f" >> "$OUT"
  timeout -k 5 300 node --test --test-concurrency=1 --test-timeout=90000 "$f" >> "$OUT" 2>&1; r=$?; echo "=== RC $r $f" >> "$OUT"; [ $r -eq 0 ] || rc=1
done
cd "$N"; rm -rf "$T"; exit $rc
