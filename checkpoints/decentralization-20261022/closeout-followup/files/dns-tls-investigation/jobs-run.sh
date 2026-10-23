#!/usr/bin/env bash
# ONE queued job, three trees (each the installed relay lineage ad074e2):
#   candidate  = the fix (measurement-predict DAG cache + certs.js bounded evidence wait) + new tests  -> all must PASS
#   base       = unchanged sources + the new tests  -> authority tests PASS (installed behaviour), 202/DAG tests FAIL
#   rejected   = the withdrawn verdict-reuse patch + the authority tests -> must FAIL
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/dns-tls-investigation
rc=0
echo "=== candidate"; "$H/job-tests.sh" test/shield-market-cert-authority.test.mjs test/shield-marketplace.test.mjs test/shield-app-verifier.test.mjs test/relay-shield-app-fresh.test.mjs test/certs.test.mjs test/measurement-predict.test.mjs; c=$?; echo "=== candidate exit=$c"; [ $c -ne 0 ] && rc=1
echo "=== base: authority (expect PASS)"; TREE="$H/base" JOB_SEC=200 "$H/job-tests.sh" test/shield-market-cert-authority.test.mjs; b1=$?; echo "=== base authority exit=$b1"; [ $b1 -ne 0 ] && rc=1
echo "=== base: certs + measurement-predict (expect the two new tests to FAIL)"; TREE="$H/base" JOB_SEC=300 "$H/job-tests.sh" test/certs.test.mjs test/measurement-predict.test.mjs; b2=$?; echo "=== base new-tests exit=$b2"; [ $b2 -eq 0 ] && rc=1
echo "=== rejected verdict reuse: authority (expect FAIL)"; TREE="$H/rejected" JOB_SEC=200 "$H/job-tests.sh" test/shield-market-cert-authority.test.mjs; r=$?; echo "=== rejected exit=$r"; [ $r -eq 0 ] && rc=1
echo "=== overall rc=$rc"; exit $rc
