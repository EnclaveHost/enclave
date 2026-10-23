#!/usr/bin/env bash
# host-service-lifecycle job runner. TREE (default candidate). Offline: ssh/scp/sftp denial stubs proven first, a private
# user+net+pid namespace (loopback only) with --kill-child, node --test-timeout per test, outer timeout -k (JOB_SEC).
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle
TREE="${TREE:-$HERE/candidate}"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp/t"; mkdir -p "$TMPDIR"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$TREE"; echo "[job] tree $TREE head $(git rev-parse HEAD) dirty=$(git status --porcelain --untracked-files=no | wc -l)"
sha256sum network/host-service-transport.mjs network/wg-circuit-runtime.mjs network/privacy-agent.mjs "$@"
set +e
timeout -k 10 "${JOB_SEC:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-timeout="$0" --test-concurrency=1 --test-reporter=spec "$@"' "${TEST_TIMEOUT_MS:-120000}" "$@"; rc=$?
set -e; echo "[job] exit=$rc"; exit "$rc"
