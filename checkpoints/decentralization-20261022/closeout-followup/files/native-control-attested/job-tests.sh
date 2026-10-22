#!/usr/bin/env bash
# native-control-attested: run the given test files offline. ssh/scp/sftp denial stubs first in PATH (proved), loopback-only
# network namespace (DNS proved unreachable), TMPDIR on disk. Usage: job-tests.sh <test file>...  Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do
  got="$(command -v "$t")"; [ "$got" = "$HERE/stubs/$t" ] || { echo "[job] FAIL: $t resolves to $got"; exit 90; }
  [ "$(timeout 5 env bash -c "command -v $t")" = "$HERE/stubs/$t" ] || exit 91
  set +e; timeout 5 "$t" probe >/dev/null 2>&1; rc=$?; set -e; [ "$rc" -eq 97 ] || exit 92
done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$HERE/repo"; echo "[job] base $(git rev-parse HEAD) + working tree:"; git status --short
sha256sum "$@" metal/guest/measured-control.mjs metal/guest/gsup.mjs network/native-control-routes.mjs relay/native-discovery.mjs scripts/native-control-certificate.mjs
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; if getent hosts kdsintf.amd.com >/dev/null 2>&1; then echo "[job] FAIL: DNS reachable"; exit 93; fi; echo "[job] offline namespace: loopback only";
  exec node --test --test-concurrency=1 --test-reporter=spec "$@"' bash "$@"
rc=$?; set -e
echo "[job] node --test exit=$rc"; exit "$rc"
