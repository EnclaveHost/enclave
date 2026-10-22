#!/usr/bin/env bash
# Focused native control discovery suites, offline: ssh/scp/sftp denial stubs first in PATH (proved below), no network
# namespace beyond loopback (unshare -r -n), TMPDIR on disk. Immutable: a change is a new file.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-discovery
REPO="$HERE/repo"
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"
for t in ssh scp sftp; do
  got="$(command -v "$t")"; [ "$got" = "$HERE/stubs/$t" ] || { echo "[job] FAIL: $t resolves to $got, not the stub"; exit 90; }
  got2="$(timeout 5 env bash -c "command -v $t")"; [ "$got2" = "$HERE/stubs/$t" ] || { echo "[job] FAIL: timeout/env resolve $t to $got2"; exit 91; }
  set +e; timeout 5 "$t" probe >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -eq 97 ] || { echo "[job] FAIL: $t stub did not deny (rc=$rc)"; exit 92; }
  echo "[job] $t -> $got (denies, rc=97)"
done
export TMPDIR="$HERE/tmp"
cd "$REPO"
echo "[job] node $(node --version), HEAD $(git rev-parse HEAD)"
sha256sum network/native-control-routes.mjs network/service-index.mjs relay/native-discovery.mjs test/native-control-routes.test.mjs test/native-discovery.test.mjs
set +e
unshare -r -n bash -c 'set -euo pipefail; ip link set lo up; if getent hosts mainnet.base.org >/dev/null 2>&1; then echo "[job] FAIL: DNS reachable inside the namespace"; exit 93; fi; echo "[job] offline namespace: loopback only";
  exec node --test --test-concurrency=1 --test-reporter=spec test/native-control-routes.test.mjs test/native-discovery.test.mjs'
rc=$?
set -e
echo "[job] node --test exit=$rc"
exit "$rc"
