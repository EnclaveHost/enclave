#!/usr/bin/env bash
# proposed canonical integration: new admission test + the frozen same-route suite on the FIXED tree; the new test on BASE
run(){ (cd $1 && unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 --test-reporter=spec "$@"' _ "${@:2}") 2>&1; }
echo "=== FIXED 95edf767"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/deploy/integration/tree test/route-same-route-admission.test.mjs test/route-same-route-churn.test.mjs test/route-context-churn.test.mjs test/public-directory.test.mjs test/route-record.test.mjs test/route-partial-qualification.test.mjs
echo "=== BASE 4a45d6d4"; run /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/deploy/integration/base-tree test/route-same-route-admission.test.mjs
