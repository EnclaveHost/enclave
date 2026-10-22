#!/usr/bin/env bash
# Adversarial reproduction against the DRAFT commit 6e46c06da (worktree draft-6e46c06d): PASS = the substitution defect is
# reproduced. Offline: denial stubs proved first in PATH, loopback-only namespace, TMPDIR on disk. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-discovery
D="$HERE/draft-6e46c06d"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || { echo "[job] FAIL: $t not stubbed"; exit 90; }; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$D"; echo "[job] draft HEAD $(git rev-parse HEAD)"
sha256sum network/native-control-routes.mjs test/native-control-substitution.test.mjs
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec test/native-control-substitution.test.mjs'
rc=$?; set -e
echo "[job] node --test exit=$rc"; exit "$rc"
