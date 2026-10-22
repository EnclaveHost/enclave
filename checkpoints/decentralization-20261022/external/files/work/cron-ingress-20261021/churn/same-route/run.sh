#!/usr/bin/env bash
# run the given test files in tree/ (no network: unshared namespace, loopback only)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/tree && exec unshare -rn bash -c 'ip link set lo up; node --test --test-concurrency=1 --test-reporter=spec "$@"' _ "$@"
