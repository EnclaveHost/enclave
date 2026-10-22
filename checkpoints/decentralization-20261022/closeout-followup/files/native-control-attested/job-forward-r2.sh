#!/usr/bin/env bash
# Role forwarding: (1) the full regression on the work tree; (2) the SAME test file, wrong-key + setup cases only, against the
# UNMODIFIED base role (base-eaea7e46, test copied in): expected to FAIL there (the vulnerability), retained as evidence.
# Offline (loopback-only namespace), ssh/scp/sftp denial stubs proved. Immutable.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; "$t" x >/dev/null 2>&1; [ $? -eq 97 ] || exit 92; done
echo "[job] ssh/scp/sftp -> denial stubs (rc=97)"
run() { (cd "$1" && sha256sum metal/guest/platform-api-role.mjs test/platform-api-forward.test.mjs && unshare -r -n bash -c 'ip link set lo up; exec node --test --test-concurrency=1 --test-reporter=spec "$@"' bash "${@:2}"); }
echo "[job] ===== work tree $(git -C "$HERE/repo" rev-parse HEAD) + working changes"
run "$HERE/repo" test/platform-api-forward.test.mjs; w=$?; echo "[job] work tree exit=$w"
echo "[job] ===== UNMODIFIED base $(git -C "$HERE/base-eaea7e46" rev-parse HEAD) role (expected to fail the wrong-key case)"
run "$HERE/base-eaea7e46" --test-name-pattern="^setup|WRONG-KEY" test/platform-api-forward.test.mjs; b=$?; echo "[job] base exit=$b"
exit "$w"
