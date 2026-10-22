#!/usr/bin/env bash
# G3 final package, job 2: the existing host-services suites touching roles.mjs/runner/stage-tool (not placement).
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package; T=$G/tree; L=$G/logs; cd "$T"
run() { local n=$1; shift; timeout 600 "$@" > $L/t-$n.out 2>&1; local rc=$?; echo "$n rc=$rc $(grep -E '^# (pass|fail)' $L/t-$n.out | tr '\n' ' ') $(grep '^not ok' $L/t-$n.out | cut -c1-90 | tr '\n' '|')"; }
for t in host-services-registry-id hosted-services-appstatic host-service-transport host-service-dns-publication; do run $t node --test --test-timeout=300000 test/$t.test.mjs; done
