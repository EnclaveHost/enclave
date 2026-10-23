#!/usr/bin/env bash
# public-rpc-host-role test runner (adapted from host-service-rpc-closure/job.sh). Offline: ssh/scp/sftp denial stubs proven
# first; a private user+net+pid namespace (loopback only) with --kill-child; node --test-timeout per test; outer timeout -k
# (JOB_SEC). STRICT=1: any skipped or cancelled test fails the job (ALLOW_SKIPPED=N permits exactly N).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${TREE:-$HERE/repo}"
export PATH="$HERE/stubs:$HOME/.foundry/bin:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp/t"; mkdir -p "$TMPDIR"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97); anvil: $(command -v anvil || echo none)"
cd "$TREE"; echo "[job] tree $TREE head $(git rev-parse HEAD) dirty=$(git status --porcelain --untracked-files=no | wc -l) untracked=$(git status --porcelain | grep -c '^??' || true)"
sha256sum network/public-rpc.mjs network/public-rpc-config.mjs network/public-rpc-hosts.mjs network/host-services/roles.mjs network/host-services/runner.mjs network/host-service-names.mjs network/host-service-transport.mjs network/wg-provider/provider.mjs "$@" 2>/dev/null || true
set +e
timeout -k 10 "${JOB_SEC:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-timeout="$0" --test-concurrency=1 --test-reporter=spec ${NODE_TEST_ARGS:-} "$@"' "${TEST_TIMEOUT_MS:-300000}" "$@" | tee "$TMPDIR/last-run.out"; rc=${PIPESTATUS[0]}
set -e
if [ "${STRICT:-0}" = 1 ]; then
  sk=$(grep -E '^ℹ (skipped|cancelled) ' "$TMPDIR/last-run.out" | awk '{s+=$3} END {print s+0}')
  echo "[job] strict: skipped+cancelled=$sk"; [ "$sk" = "${ALLOW_SKIPPED:-0}" ] || rc=7
fi
echo "[job] exit=$rc"; exit "$rc"
