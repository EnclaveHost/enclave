#!/usr/bin/env bash
# Final fail-closed source: focused suite, then the final mutation control. Offline: denial stubs proved first in PATH,
# loopback-only namespace, TMPDIR on disk. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-discovery
REPO="$HERE/repo"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do
  got="$(command -v "$t")"; [ "$got" = "$HERE/stubs/$t" ] || { echo "[job] FAIL: $t resolves to $got"; exit 90; }
  [ "$(timeout 5 env bash -c "command -v $t")" = "$HERE/stubs/$t" ] || exit 91
  set +e; timeout 5 "$t" probe >/dev/null 2>&1; rc=$?; set -e; [ "$rc" -eq 97 ] || exit 92
  echo "[job] $t -> $got (denies, rc=97)"
done
cd "$REPO"; echo "[job] HEAD $(git rev-parse HEAD) (+ working tree)"; git status --short
sha256sum relay/native-discovery.mjs test/native-discovery.test.mjs docs/design/nan-retirement.md network/service-index.mjs
git diff --quiet 6f2c7da466dc26e5f7aac88c574a6b807e1a03df -- network/ && echo "[job] network/ identical to 6f2c7da4" || { echo "[job] FAIL: network/ differs from 6f2c7da4"; exit 94; }
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; if getent hosts mainnet.base.org >/dev/null 2>&1; then exit 93; fi; echo "[job] offline namespace: loopback only";
  exec node --test --test-concurrency=1 --test-reporter=spec test/native-discovery.test.mjs'
rc=$?; set -e
echo "[job] node --test exit=$rc"; [ "$rc" -eq 0 ] || exit "$rc"
python3 -u "$HERE/mutants-final.py"
