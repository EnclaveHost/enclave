#!/usr/bin/env bash
# dns-tls-investigation (copy of relay-release-list-review/job-tests.sh; only HERE differs): run the given test files in TREE (default: candidate), offline. ssh/scp/sftp denial
# stubs proved first in PATH; TMPDIR on disk; hard bounds: node --test-timeout per test (TEST_TIMEOUT_MS, 60000), a PID
# namespace with --kill-child and an outer timeout -k (JOB_SEC, 540).
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/dns-tls-investigation
TREE="${TREE:-$HERE/candidate}"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$TREE"; echo "[job] tree $TREE"; sha256sum relay/secrets-release.mjs relay/secrets.js supervisor.js "$@"
set +e
timeout -k 10 "${JOB_SEC:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-timeout="$0" --test-concurrency=1 --test-reporter=spec "$@"' "${TEST_TIMEOUT_MS:-60000}" "$@"
rc=$?; set -e; echo "[job] node --test exit=$rc"; exit "$rc"
