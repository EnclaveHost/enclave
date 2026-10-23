#!/bin/bash
# r2: the same recipe for the rollout-closure source ab589bf8 (= root a5eae96c + tests), into NEW paths (out-r2, repo-r2,
#     repo-r2b), verified with verify-custodian-v4.mjs. The c95dcd3a build (out/, repo/, repo-b/) is preserved untouched.
# RELEASE build of the corrected custodian image (custodian ONLY) from the frozen, root-reviewed durability commit c95dcd3a,
# for the immutable original vault 0xe486…, its book 0xab21… and host ownership 0xbbd8…, with the same production host policy.
# Recipe: work/custody-release/build-release-b.sh (same builder flags, base, offline lockfile installs), adapted:
#   - TWO fresh, independent clones of the commit (--no-local: own object store), each with its own offline `npm ci`;
#   - no --allow-dirty; no tool installs; Go runs with GOPROXY=off (the pinned go1.27.0 toolchain is already cached);
#   - verify-custodian-v4.mjs on each (lineage to the verified c635fd68 release, sources, packages, measured config);
#   - A == B: initramfs bytes, kernel, cmdline, manifest measurement/files/initramfs/commit.
# The rewrap image is NOT rebuilt: v4 (as v3) checks its closure is unchanged since c635fd68 and points at that frozen artifact.
# Immutable once written. Every step's status is checked; no output filtering.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../custody-v2-durability-20261023/repo"
COMMIT=ab589bf80b669c9671b53573d489b6c6c45779ea
BASE=/home/steven/enclave-prod/dist-custody-9e5fb2028
FROZEN="$HERE/../custody-release/out"
PATCHES="$HERE/../custody-v2-durability-20261023"
VAULT=0xe48699b8401564aace7a814ae4569b67a3f7eef5; BOOK=0xab214342d5a490150a4a977063a2f88e21f80907; OWN=0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7
OVMF_FILE=${OVMF:-$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd}
export GOPROXY=off GOTOOLCHAIN_DOWNLOADS=off
for d in out-r2 repo-r2 repo-r2b; do [ ! -e "$HERE/$d" ] || { echo "FAIL: $d exists"; exit 2; }; done
mkdir -p "$HERE/out-r2"
echo "== inputs outside the repository: base and OVMF, as the c635fd68 release used them"
check() { local got; got=$(sha256sum "$1" | cut -d' ' -f1); [ "$got" = "$2" ] || { echo "FAIL: $1 sha256 $got != $2"; exit 5; }; echo "ok $1 $got"; }
check "$BASE/initramfs.cpio.gz" 7169150f50ae69b8cb85d433f5a2b44ea7553968408d9dfd373caa03a8c146e5
check "$BASE/vmlinuz" 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
check "$OVMF_FILE" 142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9
clone() {   # $1 checkout dir: an independent clone of the commit with its own offline lockfile install
  git clone --no-local --no-hardlinks --quiet "$SRC" "$1"
  git -C "$1" checkout --quiet --detach "$COMMIT"
  git -C "$1" remote remove origin
  [ "$(git -C "$1" rev-parse HEAD)" = "$COMMIT" ] || { echo "FAIL: $1 is not at $COMMIT"; exit 3; }
  (cd "$1" && npm ci --offline --ignore-scripts --no-audit --no-fund --loglevel=warn && cd relay && npm ci --offline --ignore-scripts --no-audit --no-fund --loglevel=warn)
}
build() {   # $1 checkout, $2 output prefix
  cd "$1"
  [ -z "$(git status --porcelain)" ] || { echo "FAIL: $1 is not clean"; exit 3; }
  echo "== $2: custodian (commit $(git rev-parse HEAD))"
  node scripts/build-custodian-v2.mjs --base "$BASE" --out "$HERE/out-r2/$2-custodian" --vault "$VAULT" --host-ownership "$OWN" --book "$BOOK" \
    --host-policy release/host-policy-production.json > "$HERE/out-r2/$2-custodian.log" 2>&1
  echo "custodian exit=0"
  node "$HERE/verify-custodian-v4.mjs" "$1" "$HERE/out-r2/$2-custodian" "$FROZEN" "$PATCHES" "$HERE/out-r2/$2-verify-v4.json"
}
echo "== A: clean clone, offline install"
clone "$HERE/repo-r2"
build "$HERE/repo-r2" A
echo "== B: independent clean clone, offline install"
clone "$HERE/repo-r2b"
build "$HERE/repo-r2b" B
echo "== A == B"
cmp "$HERE/out-r2/A-custodian/initramfs.cpio.gz" "$HERE/out-r2/B-custodian/initramfs.cpio.gz"
cmp "$HERE/out-r2/A-custodian/vmlinuz" "$HERE/out-r2/B-custodian/vmlinuz"
cmp "$HERE/out-r2/A-custodian/cmdline" "$HERE/out-r2/B-custodian/cmdline"
node -e "const a=require('$HERE/out-r2/A-custodian/manifest.json'),b=require('$HERE/out-r2/B-custodian/manifest.json');for(const f of ['measurement','measurementSha256','files','initramfs','kernel','cmdline','commit','bundleInputs'])if(JSON.stringify(a[f])!==JSON.stringify(b[f])){console.log('FAIL: custodian '+f+' differs');process.exit(4)}console.log('custodian: A == B ('+a.measurement+' / '+a.measurementSha256+')')"
echo "PASS: custodian release built from $COMMIT, verified (v4) and independently reproduced; rewrap reused only as verified by v4"
