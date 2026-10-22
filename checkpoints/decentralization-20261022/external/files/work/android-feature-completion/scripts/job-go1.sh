#!/bin/bash
# Go build + unit tests of the new pVM custody client, then the JS suites incl. the Go<->JS end to end and the regressions of
# every file this work touches (one queue job, 1024 MiB: Go is in it).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion
fail=0
cd $H/tree/isolation/m2
echo "=== go build"; if go build -o /dev/null ./pvmcustody/ && go build -buildmode=c-shared -o $H/artifacts/host-libpvmcustody.so ./cmd/pvmcustody-so/; then echo "go build ok"; else echo "go build FAILED"; fail=1; fi
echo "=== go vet"; if go vet ./pvmcustody/ ./cmd/pvmcustody-so/; then echo "go vet ok"; else echo "go vet FAILED"; fail=1; fi
echo "=== go test"; go test -count=1 ./pvmcustody/ ./custody/ ./bootstrap/ ./release/ > $H/logs/go-unit.log 2>&1; rc=$?; echo "go test exit=$rc"; grep -E "^(ok|FAIL|---)" $H/logs/go-unit.log | head -20; [ $rc -ne 0 ] && fail=1
echo "=== node"
PVMC_E2E_LOG=$H/logs/go-e2e.verbose.txt $H/scripts/run-suites.sh avf2 test/custody-v2-avf.test.mjs -- avf-go1 test/custody-v2-avf-go.test.mjs -- shield-daemon2 test/custody-v2-shield-daemon.test.mjs \
  -- custody-host1 test/pvm-custody-host.test.mjs -- lifecycle1 test/pvm-independent-lifecycle.test.mjs -- profile1 test/pvm-independent-profile.test.mjs \
  -- egress1 test/pvm-egress.test.mjs -- host-agent1 test/pvm-host-agent.test.mjs -- regress-custody2 test/shield-custody.test.mjs test/custody-owner-read.test.mjs test/custody-cli-independent.test.mjs \
  || fail=1
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
