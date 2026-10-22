#!/usr/bin/env bash
# Platform API guest bundle r3 (after the standby forwarding pin fix in metal/guest/platform-api-role.mjs): the prerequisite
# relay/network-runtime.bundle.mjs must be the source-regenerated pin (pab4); build into bundle-out-r3, install into the work
# tree, then --check. Offline, denial stubs. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; done
cd "$HERE/repo"
[ "$(sha256sum relay/network-runtime.bundle.mjs | cut -c1-64)" = 8399d1434e0587c246c77bfbea5d8afac65ada130cc96abffe291afde588af1e ] || { echo "[job] FAIL: network runtime is not the pin"; exit 3; }
echo "[job] network runtime = pin 8399d143 (regenerated from source in pab4)"
rm -f "$HERE/bundle-out-r3/"*
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --out "$HERE/bundle-out-r3"
cp "$HERE/bundle-out-r3/platform-api.bundle.mjs" "$HERE/bundle-out-r3/platform-api.bundle.mjs.manifest.json" metal/guest/
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --check
sha256sum metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json metal/guest/platform-api-role.mjs
