#!/usr/bin/env bash
# The five metal-measured-control tests that boot the REAL supervisor (root-approved at 512 MiB; peak 264 MiB at 256 in
# logs/reg1.out). Only these five run. Offline, ssh/scp/sftp denial stubs proved. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$HERE/repo"; sha256sum metal/guest/measured-control.mjs metal/measured-control-verify.mjs supervisor.js test/metal-measured-control.test.mjs
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec \
  --test-name-pattern="^end to end: the real supervisor" --test-name-pattern="^refused: a TLS endpoint" --test-name-pattern="^refused: forged signature" \
  --test-name-pattern="^registry through the owner" --test-name-pattern="^the front: nonce is required" test/metal-measured-control.test.mjs'
rc=$?; set -e
echo "[job] node --test exit=$rc"; exit "$rc"
