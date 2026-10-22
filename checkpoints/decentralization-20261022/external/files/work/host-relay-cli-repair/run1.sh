#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/tree"
MAIN=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
HS=network/host-services
C1=$HS/.control-main-lease-relay-host.mjs; C2=$HS/.control-nokeepalive-lease-relay-host.mjs
trap 'rm -f "$C1" "$C2"' EXIT
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
# a negative control must FAIL; one that passes fails the batch
control() { local name=$1; shift; echo "=== CONTROL $name: $*"; "$@"; local e=$?; if [ $e -ne 0 ]; then echo "=== CONTROL-FAILED-AS-EXPECTED $name (exit $e)"; else echo "=== CONTROL-UNEXPECTEDLY-PASSED $name"; fail=1; fi; return 0; }
run node --check $HS/lease-relay-host.mjs
run node --test --test-concurrency=1 test/lease-relay-host-policy.test.mjs
# C1: main's pre-repair module (the regex refuses a registered path)
cp "$MAIN/$HS/lease-relay-host.mjs" "$C1"
control C1-main-endpoint env LEASE_RELAY_HOST_UNDER_TEST="$C1" node --test --test-name-pattern "EXACT registered endpoint" test/lease-relay-host-policy.test.mjs
# C2: this repair with ONLY the CLI keepalive removed (exact two-line edit, checked)
sed -e '/const alive = setInterval(() => {}, 1 << 30);/d' -e 's/clearInterval(alive); //' $HS/lease-relay-host.mjs > "$C2"
run test "$(diff $HS/lease-relay-host.mjs "$C2" | grep -c '^[<>]')" = 3
run test "$(grep -c 'alive' "$C2")" = 0
control C2-no-keepalive env LEASE_RELAY_HOST_UNDER_TEST="$C2" node --test --test-name-pattern "ACTUAL .run. CLI" test/lease-relay-host-policy.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
