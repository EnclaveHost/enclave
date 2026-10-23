#!/usr/bin/env bash
# job-tests.sh (serving-first-fixes copy of adapter-admission-review job-tests-r2.sh; only HERE differs): same as job-tests.sh, plus hard bounds - node --test-timeout per test (TEST_TIMEOUT_MS,
# default 120000), a PID namespace with --kill-child (every child dies with the job) and an outer timeout -k (JOB_SEC, 540).
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/serving-first-fixes
TREE="${TREE:-$HERE/candidate}"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$TREE"; echo "[job] tree $TREE"; sha256sum windows/node/host.mjs windows/node/chain.mjs network/wallet-admission.mjs "$@"
set +e
timeout -k 10 "${JOB_SEC:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-timeout="$0" --test-concurrency=1 --test-reporter=spec "$@"' "${TEST_TIMEOUT_MS:-120000}" "$@"
rc=$?; set -e; echo "[job] node --test exit=$rc"; exit "$rc"
