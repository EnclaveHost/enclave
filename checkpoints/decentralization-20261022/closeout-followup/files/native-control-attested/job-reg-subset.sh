#!/usr/bin/env bash
# Regression subset at 256 MiB: metal-measured-control without the five tests that boot the real supervisor (they peak above
# 256 MiB, logs/reg1.out) and without the gsup test (fails identically on the unmodified base, logs/gsup.out), plus
# platform-api-config. Offline, denial stubs proved. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; set +e; "$t" x >/dev/null 2>&1; rc=$?; set -e; [ $rc -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
cd "$HERE/repo"; sha256sum metal/guest/measured-control.mjs metal/guest/gsup.mjs test/metal-measured-control.test.mjs test/platform-api-config.test.mjs
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec \
  --test-skip-pattern="^end to end: the real supervisor" --test-skip-pattern="^refused: a TLS endpoint" --test-skip-pattern="^refused: forged signature" \
  --test-skip-pattern="^registry through the owner" --test-skip-pattern="^the front: nonce is required" --test-skip-pattern="^gsup: the legacy path" \
  test/metal-measured-control.test.mjs test/platform-api-config.test.mjs'
rc=$?; set -e
echo "[job] node --test exit=$rc"; exit "$rc"
