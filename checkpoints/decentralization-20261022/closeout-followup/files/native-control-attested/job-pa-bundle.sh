#!/usr/bin/env bash
# Platform API guest bundle: control on the unmodified base (must reproduce the committed bundle), staleness on the work tree,
# then a build of the work tree into bundle-out/ (the repo file is replaced only after this job, by copy, then re-checked).
# Offline, denial stubs proved. Immutable.
set -uo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"; export TMPDIR="$HERE/tmp"
for t in ssh scp sftp; do [ "$(command -v "$t")" = "$HERE/stubs/$t" ] || exit 90; done
echo "[job] ssh/scp/sftp -> denial stubs"
cd "$HERE/base-eaea7e46"; echo "[job] control: base $(git rev-parse HEAD)"
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --check; c=$?; echo "[job] base --check exit=$c"
[ "$c" -eq 0 ] || { echo "[job] FAIL: the builder does not reproduce the committed bundle here; no build"; exit 2; }
cd "$HERE/repo"
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --check; echo "[job] work tree --check exit=$? (stale expected: measured-control.mjs changed)"
rm -f "$HERE/bundle-out/"*
unshare -r -n node scripts/build-platform-api-guest-bundle.mjs --out "$HERE/bundle-out"; b=$?; echo "[job] build exit=$b"
sha256sum "$HERE/bundle-out/"* metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json
exit "$b"
