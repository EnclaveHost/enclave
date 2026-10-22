#!/bin/bash
# b: continues build-release.sh after its build A (both images, exit 0, no --allow-dirty) whose verifier v1 falsely failed
# (it fed the custodian builder's static DIRECTORIES to sourceCheck as files). Here: verify A with verify-release-v2.mjs (no
# rebuild), then the independent reproduction B and A == B. Original header follows.
# RELEASE builds of the corrected custodian and the result-attested rewrap images from the LOCAL release commit
# (repo/, unpublished), WITHOUT --allow-dirty, then an INDEPENDENT reproduction from a fresh clone of the same commit with its
# own offline lockfile install. Immutable once written. Every step's status is checked; no output filtering.
#   A: repo/            -> out/A-custodian, out/A-rewrap      (+ verify-release.mjs)
#   B: repo-b/ (clone)  -> out/B-custodian, out/B-rewrap      (+ verify-release.mjs)
#   A == B: initramfs bytes, kernel, files, measurement
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
HERE=$(cd "$(dirname "$0")" && pwd)
BASE=/home/steven/enclave-prod/dist-custody-9e5fb2028
VAULT=0xe48699b8401564aace7a814ae4569b67a3f7eef5; BOOK=0xab214342d5a490150a4a977063a2f88e21f80907; OWN=0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7
MAIN="$HERE/../enclave"
mkdir -p "$HERE/out"
for d in out/B-custodian out/B-rewrap repo-b; do [ ! -e "$HERE/$d" ] || { echo "FAIL: $d exists"; exit 2; }; done
for d in out/A-custodian out/A-rewrap; do [ -f "$HERE/$d/manifest.json" ] || { echo "FAIL: $d missing"; exit 2; }; done
build() {   # $1 checkout, $2 output prefix
  cd "$1"
  [ -z "$(git status --porcelain)" ] || { echo "FAIL: $1 is not clean"; exit 3; }
  echo "== $2: custodian (commit $(git rev-parse HEAD))"
  node scripts/build-custodian-v2.mjs --base "$BASE" --out "$HERE/out/$2-custodian" --vault "$VAULT" --host-ownership "$OWN" --book "$BOOK" \
    --host-policy release/host-policy-production.json > "$HERE/out/$2-custodian.log" 2>&1
  echo "custodian exit=0"
  echo "== $2: rewrap"
  node scripts/build-custody-rewrap.mjs --base "$BASE" --out "$HERE/out/$2-rewrap" --vault "$VAULT" --book "$BOOK" \
    --host-policy release/host-policy-production.json > "$HERE/out/$2-rewrap.log" 2>&1
  echo "rewrap exit=0"
  node "$HERE/verify-release-v2.mjs" "$1" "$HERE/out/$2-custodian" "$HERE/out/$2-rewrap" "$MAIN" "$HERE/out/$2-verify-v2.json"
}
echo "== A: verify the existing release build (verify-release-v2.mjs)"
[ -z "$(git -C "$HERE/repo" status --porcelain)" ] || { echo "FAIL: repo is not clean"; exit 3; }
node "$HERE/verify-release-v2.mjs" "$HERE/repo" "$HERE/out/A-custodian" "$HERE/out/A-rewrap" "$MAIN" "$HERE/out/A-verify-v2.json"
echo "== B: independent clone of the release commit, offline lockfile install"
COMMIT=$(git -C "$HERE/repo" rev-parse HEAD)
git clone --no-hardlinks --quiet "$HERE/repo" "$HERE/repo-b"
git -C "$HERE/repo-b" checkout --quiet --detach "$COMMIT"
git -C "$HERE/repo-b" remote remove origin
(cd "$HERE/repo-b" && npm ci --offline --ignore-scripts --no-audit --no-fund --loglevel=warn && cd relay && npm ci --offline --ignore-scripts --no-audit --no-fund --loglevel=warn)
build "$HERE/repo-b" B
echo "== A == B"
for k in custodian rewrap; do
  cmp "$HERE/out/A-$k/initramfs.cpio.gz" "$HERE/out/B-$k/initramfs.cpio.gz"
  cmp "$HERE/out/A-$k/vmlinuz" "$HERE/out/B-$k/vmlinuz"
  cmp "$HERE/out/A-$k/cmdline" "$HERE/out/B-$k/cmdline"
  node -e "const a=require('$HERE/out/A-$k/manifest.json'),b=require('$HERE/out/B-$k/manifest.json');for(const f of ['measurement','measurementSha256','files','initramfs','commit'])if(JSON.stringify(a[f])!==JSON.stringify(b[f])){console.log('FAIL: $k '+f+' differs');process.exit(4)}console.log('$k: A == B ('+a.measurementSha256+')')"
done
echo "PASS: release builds verified and independently reproduced"
