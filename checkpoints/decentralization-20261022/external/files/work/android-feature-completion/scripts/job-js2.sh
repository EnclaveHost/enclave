#!/bin/bash
# the corrected lifecycle suite, then the read-only phone funding plan (public chain reads; nothing signed)
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; fail=0
$H/scripts/run-suites.sh lifecycle2 test/pvm-independent-lifecycle.test.mjs || fail=1
cd $H && node scripts/phone-funding-plan.mjs --endpoint "https://api.enclave.host/t/pixel10-pvm-cpu" --out artifacts/phone-funding-plan.json > logs/funding-plan.out 2>&1 || { echo "funding plan FAILED"; tail -5 logs/funding-plan.out; fail=1; }
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"; exit $fail
