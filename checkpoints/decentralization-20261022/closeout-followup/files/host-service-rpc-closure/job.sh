#!/usr/bin/env bash
# host-service-rpc-closure test runner. Offline: ssh/scp/sftp denial stubs proven first; a private user+net+pid namespace
# (loopback only) with --kill-child; node --test-timeout per test; outer timeout -k (JOB_SEC). EXTRA_PATH: e.g. Foundry.
# STRICT=1: any skipped or cancelled test fails the job (nothing silently skipped).
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure
TREE="${TREE:-$HERE/candidate}"
export PATH="$HERE/stubs:${EXTRA_PATH:+$EXTRA_PATH:}/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp/t"; mkdir -p "$TMPDIR"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97); anvil: $(command -v anvil || echo none)"
cd "$TREE"; echo "[job] tree $TREE head $(git rev-parse HEAD) dirty=$(git status --porcelain --untracked-files=no | wc -l)"
sha256sum network/privacy-agent.mjs network/host-service-transport.mjs network/wg-circuit-runtime.mjs windows/node/host.mjs windows/node/chain.mjs "$@"
set +e
timeout -k 10 "${JOB_SEC:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-timeout="$0" --test-concurrency=1 --test-reporter=spec ${NODE_TEST_ARGS:-} "$@"' "${TEST_TIMEOUT_MS:-300000}" "$@" | tee "$TMPDIR/last-run.out"; rc=${PIPESTATUS[0]}
set -e
if [ "${STRICT:-0}" = 1 ]; then
  sk=$(grep -E '^ℹ (skipped|cancelled) ' "$TMPDIR/last-run.out" | awk '{s+=$3} END {print s+0}')
  echo "[job] strict: skipped+cancelled=$sk"; [ "$sk" = "${ALLOW_SKIPPED:-0}" ] || rc=7
fi
echo "[job] exit=$rc"; exit "$rc"
