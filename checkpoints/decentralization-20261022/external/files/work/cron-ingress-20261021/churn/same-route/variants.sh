#!/usr/bin/env bash
# negative control (base 4a45d6d4), stability x3 (base, fixed), and 3 mutants of the fix; same final test file everywhere
T=test/route-same-route-churn.test.mjs
run(){ (cd $1 && unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 --test-reporter=spec '"$2"' 2>&1' | grep -E "^(✔|✖) |^ℹ (pass|fail)" | grep -v "^✖ failing" ); }
for i in 1 2 3; do echo "=== base 4a45d6d4 run $i"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/variants/base $T; done
for i in 1 2 3; do echo "=== FIXED 95edf767 run $i"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/tree $T; done
for v in m1-on-error m2-no-bound m3-ignore-routes; do echo "=== MUTANT $v"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/variants/$v $T; done
