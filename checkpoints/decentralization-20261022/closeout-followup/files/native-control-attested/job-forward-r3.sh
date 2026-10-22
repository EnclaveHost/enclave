#!/usr/bin/env bash
# Role forwarding regression on the work tree only (the base comparison is fw3/fw4). Offline, denial stubs proved. Immutable.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; "$t" x >/dev/null 2>&1; [ $? -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$HERE/repo"; sha256sum metal/guest/platform-api-role.mjs test/platform-api-forward.test.mjs
unshare -r -n bash -c 'ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec test/platform-api-forward.test.mjs'
