#!/usr/bin/env bash
# Platform API guest bundle, r2 (after the verified-chip change to metal/measured-control-verify.mjs), with its generated
# prerequisite REGENERATED from source in each isolated checkout (relay/build-network.mjs, the composition build order:
# host-admission and lease bundles are committed; network runtime next; platform-api last):
#   1. base worktree (eaea7e46): network runtime -> must equal the committed platform-api manifest's pin 8399d143;
#      then platform-api --check must reproduce the committed bundle (control);
#   2. work tree: network runtime -> must equal 8399d143 too (no input of it changed); platform-api built into bundle-out-r2.
# Offline (loopback-only namespace), ssh/scp/sftp denial stubs. Frozen trees are never touched. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; done
echo "[job] ssh/scp/sftp -> denial stubs"
PIN=8399d1434e0587c246c77bfbea5d8afac65ada130cc96abffe291afde588af1e
regen() {   # $1 = checkout: regenerate relay/network-runtime.bundle.mjs in place and require the pin
  local d="$1"; rm -f "$d/relay/network-runtime.bundle.mjs" "$d/relay/network-runtime.bundle.mjs.manifest.json"
  (cd "$d" && unshare -r -n node relay/build-network.mjs)
  local got; got=$(sha256sum "$d/relay/network-runtime.bundle.mjs" | cut -c1-64)
  [ "$got" = "$PIN" ] || { echo "[job] FAIL: $d network runtime $got != pin $PIN"; exit 3; }
  echo "[job] $d: network runtime regenerated = pin $PIN"
}
regen "$HERE/base-eaea7e46"
(cd "$HERE/base-eaea7e46" && echo "[job] base $(git rev-parse HEAD) clean=$(git status --short --untracked-files=no | wc -l)" && unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --check)
echo "[job] base platform-api --check passed (control reproduces the committed bundle)"
regen "$HERE/repo"
cd "$HERE/repo"; rm -f "$HERE/bundle-out-r2/"*
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --out "$HERE/bundle-out-r2"
sha256sum "$HERE/bundle-out-r2/"* metal/measured-control-verify.mjs metal/guest/measured-control.mjs
