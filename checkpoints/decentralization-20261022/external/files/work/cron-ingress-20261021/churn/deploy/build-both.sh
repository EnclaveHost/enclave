#!/usr/bin/env bash
# Same recipe as ../../deploy/build.mjs (esbuild 0.28.1, same entry/options): reproduce live 2467cea0, then the candidate.
set -eu; cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-20261021/churn/deploy
node build.mjs src-current out-current
node build.mjs src-candidate out-candidate
sha256sum out-current/enclave-directory.mjs out-candidate/enclave-directory.mjs ../../deploy/out-patched/enclave-directory.mjs ../../root-rollout/kit/enclave-directory.mjs
cmp out-current/enclave-directory.mjs ../../root-rollout/kit/enclave-directory.mjs && echo "REPRODUCED live 2467cea0 byte-identical"
