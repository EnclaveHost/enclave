#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/deploy && node delta-proof.mjs && for n in plain noident; do diff delta-proof/src-current.$n.mjs delta-proof/src-candidate.$n.mjs > delta-proof/$n.diff; echo "$n.diff: $(grep -c '^[<>]' delta-proof/$n.diff) changed lines"; done; cat delta-proof/plain.diff
