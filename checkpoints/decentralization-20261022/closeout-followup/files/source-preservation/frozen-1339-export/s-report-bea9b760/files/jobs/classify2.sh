#!/usr/bin/env bash
# the daemon stop exit-code class (f1 carriers, f2 cold-start): 3 runs each on the candidate and on pristine 14d1e495, both with
# the test-only stop diagnostic (exit code/signal + daemon output tail)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
for i in 1 2 3; do for T in repo baseline-14d1; do
  echo "=== $T run $i"
  TREE="$HERE/$T" JOB_SEC=400 bash "$HERE/jobs/job.sh" test/host-services-cold-start.test.mjs test/host-services-carriers.test.mjs > "$HERE/tmp/c2-$T-$i.log" 2>&1
  grep -E "^(✖|ℹ (pass|fail))|exit=|head " "$HERE/tmp/c2-$T-$i.log" | head -12; grep -A3 "stop: {" "$HERE/tmp/c2-$T-$i.log" | head -8 | cut -c1-1500
done; done
