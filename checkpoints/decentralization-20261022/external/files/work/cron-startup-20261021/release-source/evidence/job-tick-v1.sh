#!/usr/bin/env bash
# ONE queued job (512 MiB). The single-flight tick patch on BOTH bases, each in a scratch tree (main/live not edited):
#   live = main's tree + the LIVE source closure (work/windows-local-relay-migration/stage/source: host.mjs 2500c650) on top
#   main = work/enclave as is (host.mjs d4b5d417)
# For each: the new test on the UNPATCHED host (negative control); then the patched host: the new test; and the existing
# tick-path suites BEFORE and AFTER the patch (no regression = same results). Fake Base RPC on loopback only.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; H=$W/cron-startup-20261021/host-tick
export TMPDIR=$H/tmp; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR" "$H/results"
date -u +%FT%TZ > "$H/tick-started.utc"
EXIST="test/windows-node-wallet-policy.test.mjs test/windows-node-stopapp-tick.test.mjs test/windows-node-norenew.test.mjs test/windows-node-giveup-once.test.mjs"
run() { # $1 name, $2 base dir with windows/node/host.mjs (a), $3 patched host.mjs (b), $4 overlay dir or ""
  local n=$1 S=$H/tree-$1; rm -rf "$S"
  rsync -a --exclude .git --exclude node_modules "$W/enclave/" "$S/"
  [ -n "$4" ] && rsync -a "$4/" "$S/"
  for nm in node_modules network/node_modules relay/node_modules sdk/sessions/node_modules e2e/node_modules; do [ -d "$W/enclave/$nm" ] && ln -sfn "$W/enclave/$nm" "$S/$nm"; done
  cp "$H/b/test/windows-node-tick-single-flight.test.mjs" "$S/test/"
  cd "$S"
  [ "$(sha256sum < windows/node/host.mjs | cut -c1-64)" = "$(sha256sum < "$2" | cut -c1-64)" ] || { echo "$n: host.mjs is not the patch base"; exit 1; }
  set +e
  node --test --test-concurrency=1 --test-reporter=tap test/windows-node-tick-single-flight.test.mjs > "$H/results/$n-control.tap" 2>&1
  node --test --test-concurrency=1 --test-reporter=tap $EXIST > "$H/results/$n-existing-before.tap" 2>&1
  cp "$3" windows/node/host.mjs
  node --test --test-concurrency=1 --test-reporter=tap test/windows-node-tick-single-flight.test.mjs > "$H/results/$n-patched.tap" 2>&1
  node --test --test-concurrency=1 --test-reporter=tap $EXIST > "$H/results/$n-existing-after.tap" 2>&1
  set -e
  for v in control patched existing-before existing-after; do echo "== $n $v"; grep -E "^(not )?ok [0-9]+ |^# (tests|pass|fail|skipped|cancelled)" "$H/results/$n-$v.tap"; done
  cd "$H"; rm -rf "$S"
}
run live "$H/live-a/windows/node/host.mjs" "$H/live-b/windows/node/host.mjs" "$W/windows-local-relay-migration/stage/source"
run main "$H/a/windows/node/host.mjs" "$H/b/windows/node/host.mjs" ""
date -u +%FT%TZ > "$H/tick-finished.utc"
echo TICK-JOB-DONE
