#!/usr/bin/env bash
T=test/route-same-route-churn.test.mjs
run(){ (cd $1 && unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 --test-reporter=spec '"$2"' 2>&1' | grep -E "^(✔|✖) |^ℹ (tests|pass|fail)" | grep -v "^✖ failing" ); }
for v in base m3-ignore-routes m1-on-error m2-no-bound; do echo "=== $v"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/variants/$v $T; done
echo "=== FIXED 95edf767"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/tree $T
