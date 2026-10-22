#!/usr/bin/env bash
# G3 final package: ONE hosted-service-placement test by name (the whole file needs ~560 MiB; split under the 512 cap).
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/g3-final-package; T=$G/tree; L=$G/logs; cd "$T"
n=$1; pat=$2
timeout 900 node --test --test-timeout=600000 --test-name-pattern="$pat" test/hosted-service-placement.test.mjs > $L/t-placement-$n.out 2>&1; rc=$?
echo "placement-$n rc=$rc $(grep -E '^# (pass|fail|skipped)' $L/t-placement-$n.out | tr '\n' ' ') $(grep '^not ok' $L/t-placement-$n.out | cut -c1-90 | tr '\n' '|')"
