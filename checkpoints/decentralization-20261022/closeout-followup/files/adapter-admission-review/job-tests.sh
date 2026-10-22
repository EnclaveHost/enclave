#!/usr/bin/env bash
# adapter-admission-review: run given test files in the candidate (or the tree given by TREE) offline. ssh/scp/sftp denial
# stubs proved first in PATH; loopback-only namespace; TMPDIR on disk. Usage: [TREE=dir] job-tests.sh <test>... Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/adapter-admission-review
TREE="${TREE:-$HERE/candidate}"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$TREE"; echo "[job] tree $TREE"; sha256sum windows/node/host.mjs network/wallet-admission.mjs "$@"
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec "$@"' bash "$@"
rc=$?; set -e; echo "[job] node --test exit=$rc"; exit "$rc"
