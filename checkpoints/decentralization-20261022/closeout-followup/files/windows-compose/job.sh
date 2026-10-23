#!/usr/bin/env bash
# windows-compose job runner (template: serving-first-fixes/job-tests.sh). MODE=build-check|build|test. Offline: ssh/scp/sftp
# denial stubs proven first, a PID+net namespace with --kill-child, node --test-timeout per test, outer timeout -k (JOB_SEC).
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-compose
TREE="${TREE:-$HERE/candidate}"
export PATH="$HERE/stubs:${EXTRA_PATH:+$EXTRA_PATH:}/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp/t"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$TREE"; echo "[job] tree $TREE mode ${MODE:-test}"
sha256sum windows/node/host.mjs windows/node/chain.mjs windows/node/agent.mjs windows/node/appzone.mjs windows/node/network-enroll.mjs windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs network/privacy-agent.mjs network/host-admission-runtime.mjs
set +e
case "${MODE:-test}" in
  build-check) timeout -k 10 "${JOB_SEC:-300}" unshare -rn --pid --fork --kill-child --mount-proc node scripts/build-host-admission.mjs --check; rc=$?;;
  build) timeout -k 10 "${JOB_SEC:-300}" unshare -rn --pid --fork --kill-child --mount-proc node scripts/build-host-admission.mjs; rc=$?
         sha256sum windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs;;
  test) sha256sum "$@"
        timeout -k 10 "${JOB_SEC:-540}" unshare -rn --pid --fork --kill-child --mount-proc sh -c 'ip link set lo up && exec node --test --test-timeout="$0" --test-concurrency=1 --test-reporter=spec "$@"' "${TEST_TIMEOUT_MS:-120000}" "$@"; rc=$?;;
  *) echo "unknown MODE"; rc=2;;
esac
set -e; echo "[job] exit=$rc"; exit "$rc"
