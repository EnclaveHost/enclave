#!/bin/bash
# One queue job (1024 MiB: Go and Java are in it): the native libraries, the Go tests, the suites this round's change touches,
# then the unsigned APKs.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; fail=0
echo "=== native"; $H/scripts/job-native.sh || fail=1
cd $H/tree/isolation/m2
echo "=== go vet+test"; go vet ./pvmcustody/ ./cmd/pvmcustody-so/ && go test -count=1 ./pvmcustody/ > $H/logs/go-unit2.log 2>&1; rc=$?; echo "go exit=$rc"; grep -E "^(ok|FAIL|---)" $H/logs/go-unit2.log | head; [ $rc -ne 0 ] && fail=1
echo "=== node"
PVMC_E2E_LOG=$H/logs/go-e2e2.verbose.txt $H/scripts/run-suites.sh avf-go2 test/custody-v2-avf-go.test.mjs -- custody-host2 test/pvm-custody-host.test.mjs || fail=1
echo "=== apk"; $H/scripts/build-apk.sh > $H/logs/build-apk.log 2>&1; rc=$?; tail -12 $H/logs/build-apk.log; [ $rc -ne 0 ] && fail=1
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
