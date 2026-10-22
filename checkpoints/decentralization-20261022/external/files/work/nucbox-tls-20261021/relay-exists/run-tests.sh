#!/usr/bin/env bash
# Patched stage: the new regression file, then the suites that exercise relay/secrets.js. Then the SAME regression file
# against the unpatched live-identical secrets.js (a copy of the stage with only that file swapped back) - it must FAIL.
set -euo pipefail
R=/home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/relay-exists
export TMPDIR=$R/tmp
cd $R/stage
node --version
node --test --test-concurrency=1 test/relay-exists-fastpath.test.mjs test/custody-relay.test.mjs test/secrets.test.mjs test/secrets-release.test.mjs test/custody-cli.test.mjs
echo "PATCHED-SUITES: PASS"
B=$R/baseline; rm -rf "$B"; mkdir -p "$B"
for f in "$R"/stage/* ; do n=$(basename "$f"); case "$n" in relay|test) ;; *) ln -sfn "$(readlink -f "$f")" "$B/$n";; esac; done
rsync -a --exclude node_modules "$R/stage/relay/" "$B/relay/"; ln -sfn "$(readlink -f "$R/stage/relay/node_modules")" "$B/relay/node_modules"
rsync -a "$R/stage/test/" "$B/test/"
cp --remove-destination "$R/live-captured/secrets.js" "$B/relay/secrets.js"
sha256sum "$B/relay/secrets.js"
cd "$B"
if node --test test/relay-exists-fastpath.test.mjs > "$R/baseline-run.out" 2>&1; then echo "BASELINE UNEXPECTEDLY PASSED"; exit 1; fi
grep -E "^# (pass|fail)" "$R/baseline-run.out"
grep -E "^not ok" "$R/baseline-run.out" || true
echo "BASELINE (live code) FAILS the regression as expected"
