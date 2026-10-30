#!/bin/bash
# GUEST preflight for the combined release (root, read-only). Usage:
#   verify-stage-release.sh STAGE RELEASE_MANIFEST_SHA RUN2_RECEIPT_SHA RUN2_OUT_SHA RUN2_RC_SHA N
# Refuses unless: the release stage == its MANIFEST and sha; the OLD stage == dd9df0ab; run 2 has ENDED (unit inactive) and its
# collected receipts pass check-run2-receipt.py against the given pins; run-2's tested tree and the run-1 cargo home exist;
# tools present; the release run dir is new; disk >= 8192 floor + 9216 release estimate; memory >= 16384 floor + 12288 cap.
set -uo pipefail
S=${1:?}; WANT=${2:?}; PR=${3:?}; PO=${4:?}; PC=${5:?}; N=${6:?}; BASE=/srv/m10-guest-validation; OLD=$BASE/stage; CACHE=$BASE/runs/run-1/build; R=$BASE/receipts; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[REFUSE] $1"; rc=1; }
[ "$(sha256sum < $S/MANIFEST.sha256 | cut -c1-64)" = "$WANT" ] && ok "release MANIFEST.sha256 == $WANT" || { echo "[REFUSE] release MANIFEST.sha256 is not $WANT"; exit 1; }
(cd $S && sha256sum -c --quiet --strict MANIFEST.sha256) && [ "$(cd $S && find . -type f ! -name MANIFEST.sha256 | wc -l)" = "$(wc -l < $S/MANIFEST.sha256)" ] && [ -z "$(cd $S && find . -type l)" ] && ok "release stage == MANIFEST, nothing unlisted" || bad "release stage differs"
[ "$(sha256sum < $OLD/MANIFEST.sha256 | cut -c1-64)" = dd9df0ab82e9f8b53a90063808bdd2199b873eafcf037fb6313d4406d4fb49ee ] && (cd $OLD && sha256sum -c --quiet --strict MANIFEST.sha256) && ok "OLD stage == dd9df0ab" || bad "OLD stage changed"
! systemctl is-active --quiet m10-guest-validation-2.service && ! systemctl is-active --quiet m7-m10-release-$N.service && ok "run-2 unit and release unit not active" || bad "run 2 (or this release) is still active"
python3 -I $S/runner/check-run2-receipt.py $R/run-2.receipt.json $R/run-2.out $R/run-2.rc $PR $PO $PC && ok "run 2 receipts pass the gate (pinned)" || bad "run-2 receipt gate refused"
[ -d $BASE/runs/run-2/build/tree ] && ok "run-2 tested tree present (read-only binding)" || bad "run-2 tree missing"
[ -d $CACHE/cargo-home/registry ] && [ "$(stat -c %U $CACHE/cargo-home)" = m10build ] && ok "run-1 cargo home present (owner m10build)" || bad "run-1 cargo home missing or not m10build"
[ ! -e $BASE/release/run-$N ] && ok "release/run-$N is new" || bad "release/run-$N exists"
for t in cc c++ gcc g++ clang make cmake pkg-config git python3 node tar readelf; do command -v $t >/dev/null && ok "$t: $(command -v $t)" || bad "missing tool $t"; done
pkg-config --exists openssl && ls /usr/lib/llvm-*/lib/libclang.so* >/dev/null 2>&1 && ok "openssl pkg-config + libclang" || bad "openssl dev or libclang missing"
id m10build >/dev/null 2>&1 && runuser -u m10build -- test ! -w $S && runuser -u m10build -- test ! -w $OLD && ok "m10build exists; stages not writable by it" || bad "user/stage permissions"
f=$(df --output=avail -m $BASE | tail -1 | tr -d ' '); [ "$f" -ge 17408 ] && ok "disk: $f MiB free >= 8192 floor + 9216 release estimate" || bad "disk: only $f MiB free (< 17408): see the alternate staging plan; nothing will be deleted"
a=$(awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo); [ "$a" -ge 28672 ] && ok "memory: $a MiB >= 16384 floor + 12288 cap" || bad "memory: $a MiB < 28672"
echo "## preflight-release rc=$rc"; exit $rc
