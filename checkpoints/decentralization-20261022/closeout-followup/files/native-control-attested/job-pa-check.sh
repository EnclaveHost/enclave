#!/usr/bin/env bash
# The installed platform API guest bundle must equal a fresh build of the work tree (--check). Offline, denial stubs. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; done
cd "$HERE/repo"; sha256sum metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json relay/network-runtime.bundle.mjs
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --check
