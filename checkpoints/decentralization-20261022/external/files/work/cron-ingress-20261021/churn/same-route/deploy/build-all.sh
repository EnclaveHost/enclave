#!/usr/bin/env bash
# Same recipe as churn/deploy (esbuild 0.28.1, same entry/options): reproduce LIVE 30cee0a9, build the candidate, delta proof.
set -eu; cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/same-route/deploy
node build.mjs src-current out-current
node build.mjs src-candidate out-candidate
cmp out-current/enclave-directory.mjs ../../root-rollout/kit/enclave-directory.mjs && echo "REPRODUCED live 30cee0a9 byte-identical (= churn/root-rollout/kit)"
sed -i "s/'src-current','src-candidate'/'src-current','src-candidate'/" delta-proof.mjs
node delta-proof.mjs
for n in plain noident; do diff delta-proof/src-current.$n.mjs delta-proof/src-candidate.$n.mjs > delta-proof/$n.diff || true; echo "$n.diff: $(grep -c '^[<>]' delta-proof/$n.diff) changed lines"; done
