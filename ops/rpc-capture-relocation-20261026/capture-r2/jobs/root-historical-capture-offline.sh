#!/bin/bash
# historical-capture-deployment-stage/r2: ROOT-OWNED, OFFLINE, FOREGROUND qualification of the relocatable capture bundle (PREPARED; not run by
# Claude). Shared root memory queue, no network:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   ./jobs/q-exit-status.sh historical-capture-offline-r2-1 1024 unshare -Urn bash historical-capture-deployment-stage/r2/jobs/root-historical-capture-offline.sh
# 1024 MiB = the r4 suite's own budget (same tests, same fixtures). Steps (any failure -> rc 1; setup problems -> rc 9):
#   r2 = the 1305 job with two HARNESS fixes only (receipt logs/root-historical-capture-1305.out, run-20261026T124322Z-1731089 kept):
#     scratch emptiness is now an actual `find -mindepth 1` inventory (was `ls -A d1 d2`, which prints headings for empty dirs), and the
#     legacy chain_service.py 75c879ec that test_segments reads at OPS is copied into the relocated TEST copy's vendor/ only.
#     The production bundle is a byte-identical copy of 020cc8bf (parent stage 7f3fb478), rebuilt here by the parent's frozen builder.
#   0 r2 freeze; parent stage 7f3fb478 entries; r2/bundle == parent bundle == bundleId 020cc8bf; r4 57d97720; pinned sources + test support
#   1 REPRODUCIBLE: tools/build_bundle.py rebuilt into a private dir == bundle/ byte-for-byte and == patches/; GNU patch r4/src + patch == lib
#   2 RELOCATED: bundle copied under a random deep path, made read-only, `bin/historical-capture verify` ok, bundleId == sha256(MANIFEST.json),
#     no /home path in any bundle text file, MANIFEST anchor N == the pinned receipt's N (52866960)
#   3 TAMPER: changed byte / extra file / missing file / exec bit flip each make verify refuse (on throwaway copies)
#   4 REAL ENTRYPOINT with the REAL pinned receipt b9a90847 (no DB exists offline): ordered refusals prove the pinned origin_extract and
#     receipt load from the relocated bundle before any DB access: wrong base sha / no db/ / writable (not read-only) datadir / altered
#     receipt / non-anchored plan input; each exits 2 or 3 with a JSON refusal and writes no output file
#   5 REAL CODE PATHS: the UNMODIFIED r4 suites test_anchored_origin (9) + test_segments (19) = 28, on a relocated TEST copy of the bundle
#     (src -> bundle lib, KZGCHECK = the bundle's kzgcheck, PINS resolve inside the copy); test-support files are added ONLY to that copy.
#     Fixture data (fake base binary/DB, fake L1 with real kzgcheck-sealed blocks and blobs); no live proof is claimed.
#   6 the relocated production copy still verifies; stage unchanged
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
P1=$W/historical-capture-deployment-stage; S=$P1/r2; BID=020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e; R4=$W/historical-origin-segments-stage/r4; C=$W/source/ops/rpc-backend-bootstrap/2026-10-25
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PT=""; rc=0
die() { echo "## SETUP: $*"; echo "## historical-capture-offline rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
ok() { echo "ok $*"; }
trap '[ -n "$PT" ] && chmod -R u+w "$PT" 2>/dev/null; [ -n "$PT" ] && rm -rf --one-file-system -- "$PT"' EXIT
mkdir -p "$OUT" || exit 9
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -v '127.0.0.0/8\|dev lo' | grep -q . && die "network route present: run under unshare -Urn"
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
# ---- 0 pins ----
bash $S/tools/freeze.sh --check || die "r2 != SHA256SUMS (exact file set + hashes)"
pin $P1/SHA256SUMS 7f3fb478445d57ca4d941d48c8a89b0011fc7ca9771f107b8e6f12144ad6b31b; (cd $P1 && sha256sum -c --quiet SHA256SUMS) || die "parent stage entries changed"
pin $S/bundle/MANIFEST.json $BID; pin $P1/bundle/MANIFEST.json $BID; diff -r $S/bundle $P1/bundle > /dev/null || die "r2/bundle is not the parent bundle byte-for-byte"
pin $R4/SHA256SUMS 57d9772024e33507797688210c8d1eb972ae57c0487bfdee0c8e99f6ab4cfe6b; (cd $R4 && sha256sum -c --quiet SHA256SUMS) || die "r4 changed"
pin $C/coverage/test_origin_extract.py b9b026da24f4b73c5a7918537fc58e9e72c2058e213a15bb858f6ee8c412d4df
pin $C/coverage/test_coverage_gate.py 5d5d8604e41f920ab72eb964516ae3b0a228824207fc5b6ab8ee4244d104fc14
pin $C/test_coverage_activation.py 24c37c51d20f164434739093dd513d9206968e0ac60aec1ba59271b1116fa6f7
pin $C/chain_service.py 75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92
PT=$(mktemp -d /tmp/hcap.XXXXXX) || die "mktemp"
export TMPDIR=$PT HOME=$PT PYTHONDONTWRITEBYTECODE=1
{ echo "node $(node --version) python $(python3 --version 2>&1) uid $(id -u)"; sha256sum < $S/SHA256SUMS; } > $OUT/env.txt
# ---- 1 reproducible build + patches ----
python3 -IB $P1/tools/build_bundle.py --out $PT/rebuilt --patches-out $PT/patches > $OUT/rebuild.json 2>&1 || fail "rebuild (see rebuild.json)"
diff -r $S/bundle $PT/rebuilt > $OUT/rebuild.diff 2>&1 && diff -r $P1/patches $PT/patches >> $OUT/rebuild.diff 2>&1 && ok "rebuild == bundle/ and patches/" || fail "rebuild differs (rebuild.diff)"
for f in anchored_origin.py segments.py; do
  cp $R4/src/$f $PT/$f && patch -s $PT/$f < $P1/patches/$f.patch && cmp -s $PT/$f $S/bundle/lib/$f && ok "r4/src/$f + patch == bundle lib" || fail "patch $f"; done
for f in anchored_acceptance.py bind_anchor.mjs; do cmp -s $R4/src/$f $S/bundle/lib/$f && ok "lib/$f == r4 byte" || fail "lib/$f differs from r4"; done
# ---- 2 relocated, read-only ----
D=$PT/reloc/$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')/opt/enclave-rpc/historical-capture; mkdir -p $D
cp -a $S/bundle $D/b && chmod -R a-w $D/b || die "relocate"
HC=$D/b/bin/historical-capture
$HC verify > $OUT/verify.json 2> $OUT/verify.err && ok "relocated verify" || fail "relocated verify (verify.err)"
python3 -IB - $OUT/verify.json $D/b <<'PY' || fail "verify output"
import hashlib, json, os, sys
v, root = json.load(open(sys.argv[1])), sys.argv[2]
m = json.load(open(os.path.join(root, 'receipt/a1-evidence.json')))
assert v['ok'] is True and v['root'] == os.path.realpath(root), v['root']
assert v['bundleId'] == hashlib.sha256(open(os.path.join(root, 'MANIFEST.json'), 'rb').read()).hexdigest()
assert v['anchor']['N'] == int(m['N']) == 52866960 and v['anchor']['receiptSha256'] == 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'
print('verify: bundleId', v['bundleId'][:12], 'files', v['files'], 'N', v['anchor']['N'])
PY
bash -n $D/b/bin/guest-capture.sh && ok "guest-capture.sh parses" || fail "guest-capture.sh syntax"
grep -rlI '/home/' $D/b > $OUT/home-paths.txt; [ -s $OUT/home-paths.txt ] && fail "bundle names /home paths: $(cat $OUT/home-paths.txt)" || ok "no /home path in the bundle"
# ---- 3 tamper refusals ----
tamper() { local n=$1; local T=$PT/tamper-$n; cp -a $S/bundle $T; eval "$2"; if $T/bin/historical-capture verify > /dev/null 2> $OUT/tamper-$n.err; then fail "tamper $n accepted"; else ok "tamper $n refused: $(head -c 120 $OUT/tamper-$n.err)"; fi; }
tamper byte 'printf x >> $T/vendor/anchor-bootstrap.mjs'
tamper extra 'touch $T/lib/sitecustomize.py'
tamper missing 'rm $T/vendor/node_modules/@noble/hashes/utils.js'
tamper execbit 'chmod 0755 $T/lib/segments.py'
# ---- 4 real entrypoint, real pinned receipt, ordered refusals (no DB offline) ----
R=$D/b/receipt/a1-evidence.json; FB=$PT/fakebase; cp /usr/bin/true $FB; FBS=$(sha256sum < $FB | cut -c1-64)
mkdir -p $PT/dd-empty $PT/dd-rw/db $PT/scratch1 $PT/scratch2; cp $R $PT/receipt-altered.json; printf ' ' >> $PT/receipt-altered.json
refuse() {  # name expected-rc expected-substring -- args
  local n=$1 want=$2 sub=$3; shift 4; local o=$PT/out-$n.json
  "$HC" "$@" --out $o > $OUT/ep-$n.txt 2>&1; local r=$?
  if [ $r = $want ] && grep -q -- "$sub" $OUT/ep-$n.txt && [ ! -e $o ]; then ok "entrypoint $n: rc $r, $(tail -c 150 $OUT/ep-$n.txt)"; else fail "entrypoint $n: rc $r (want $want '$sub'), see ep-$n.txt"; fi; }
refuse base-sha 2 'base binary differs' -- origin --base-bin $FB --base-sha256 $(printf 0%.0s {1..64}) --datadir $PT/dd-empty --scratch $PT/scratch1 --receipt $R --node /usr/bin/node
refuse no-db 2 'datadir has no db/' -- origin --base-bin $FB --base-sha256 $FBS --datadir $PT/dd-empty --scratch $PT/scratch1 --receipt $R --node /usr/bin/node
refuse writable-db 2 'not on a read-only mount' -- origin --base-bin $FB --base-sha256 $FBS --datadir $PT/dd-rw --scratch $PT/scratch2 --receipt $R --node /usr/bin/node
refuse receipt 2 'is not the pinned' -- origin --base-bin $FB --base-sha256 $FBS --datadir $PT/dd-rw --scratch $PT/scratch2 --receipt $PT/receipt-altered.json --node /usr/bin/node
echo '{"format":"x"}' > $PT/not-anchored.json
refuse plan-input 3 'anchored-format' -- plan --anchored $PT/not-anchored.json --receipt $R --node /usr/bin/node --to-block 1
find $PT/scratch1 $PT/scratch2 -mindepth 1 > $OUT/scratch-contents.txt 2>&1; [ $? = 0 ] && [ ! -s $OUT/scratch-contents.txt ] \
  && ok "refusals left scratch empty (find -mindepth 1: no entries)" || fail "scratch written by a refusal: $(head -c 300 $OUT/scratch-contents.txt)"
# ---- 4b real CLI past the read-only gate: datadir read-only ONLY inside a private mount namespace (the guest units' model) ----
mkdir -p $PT/dd-ro/db $PT/mnt $PT/scratch3; before=$(find $PT/dd-ro | sort | sha256sum)
unshare -m --propagation private bash -c "mount --bind $PT/dd-ro $PT/mnt && mount -o remount,bind,ro $PT/mnt && \
  $HC origin --base-bin $FB --base-sha256 $FBS --datadir $PT/mnt --scratch $PT/scratch3 --receipt $R --node /usr/bin/node --out $PT/out-ro.json" \
  > $OUT/ep-private-ro.txt 2>&1; r=$?
if [ $r = 2 ] && grep -q '"refused"' $OUT/ep-private-ro.txt && ! grep -qE 'read-only mount|has no db/|base binary differs|scratch must|not the pinned' $OUT/ep-private-ro.txt \
   && [ -d $PT/scratch3/view ] && [ -d $PT/scratch3/home ] && [ ! -e $PT/out-ro.json ]; then
  ok "private-ns read-only datadir passed every pre-DB gate (pinned receipt + origin_extract + ro mount + scratch), then: $(tail -c 160 $OUT/ep-private-ro.txt)"
else fail "private-ns ro CLI step (rc $r, ep-private-ro.txt)"; fi
findmnt -n $PT/mnt > /dev/null 2>&1 && fail "the ro bind leaked into the job's mount namespace" || ok "ro bind existed only in the private namespace"
[ "$(find $PT/dd-ro | sort | sha256sum)" = "$before" ] && ok "datadir unchanged" || fail "datadir changed"
# ---- 5 unmodified r4 suites on a relocated TEST copy ----
T=$PT/tt; mkdir -p $T/case/tests; cp -a $S/bundle $T/hcb || die "test copy"
# TEST-ONLY support, added to the relocated TEST copy only (never the production bundle): test_segments reads OPS = dirname(COV) = vendor/
cp $C/coverage/test_origin_extract.py $C/coverage/test_coverage_gate.py $T/hcb/vendor/coverage/ && cp $C/test_coverage_activation.py $C/chain_service.py $T/hcb/vendor/ || die "test support"
pin $T/hcb/vendor/chain_service.py 75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92
[ ! -e $S/bundle/vendor/chain_service.py ] && [ ! -e $D/b/vendor/chain_service.py ] || die "legacy wrapper reached a production bundle copy"
for f in anchor_fixture.py anchor_fixture.mjs test_anchored_origin.py test_segments.py run_all.py; do
  grep -qx "$(sha256sum < $R4/tests/$f | cut -c1-64)  tests/$f" $R4/SHA256SUMS || die "r4 tests/$f not in r4 sums"; cp $R4/tests/$f $T/case/tests/; done
ln -s $T/hcb/lib $T/case/src
export KZGCHECK=$T/hcb/vendor/coverage/kzgcheck NODE=/usr/bin/node OPS_SOURCE=$C CHAIN_SERVICE=$C/chain_service.py
(cd $T/case/tests && PYTHONPATH=$T/case/tests python3 -B - "$T/hcb" <<'PY') > $OUT/provenance.txt 2>&1 || fail "test modules do not load from the relocated bundle (provenance.txt)"
import os, sys
import anchor_fixture as F, segments as SG, anchored_acceptance as AA
root = os.path.realpath(sys.argv[1])
paths = [os.path.realpath(F.AO.__file__), os.path.realpath(SG.__file__), os.path.realpath(AA.__file__), SG.GATE[0], *(p for p, _ in F.AO.PINS.values())]
bad = [p for p in paths if not os.path.realpath(p).startswith(root + os.sep)]
assert not bad, bad
print('all verifier modules, PINS and GATE resolve inside the relocated bundle:', root)
PY
(cd $T/case/tests && PYTHONPATH=$T/case/tests timeout 2400 python3 -B run_all.py $OUT/A.json $OUT/A.txt 28 test_anchored_origin test_segments < /dev/null > $OUT/A.summary 2>&1); r=$?
if [ $r = 0 ] && python3 -B -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["pass"] is True else 1)' $OUT/A.json; then
  ok "r4 suites on the relocated bundle: $(tail -1 $OUT/A.summary)"; else fail "r4 suites (rc $r; A.json/A.txt)"; fi
# ---- 5b runner orchestration (guest + host) with recording fakes: NOT capture evidence ----
(cd $S/tests && BUNDLE=$D/b STAGE=$S PYTHONPATH=$S/tests timeout 900 python3 -B $T/case/tests/run_all.py $OUT/R.json $OUT/R.txt 12 test_capture_runners < /dev/null > $OUT/R.summary 2>&1); r=$?
if [ $r = 0 ] && python3 -B -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["pass"] is True else 1)' $OUT/R.json; then
  ok "runner orchestration tests: $(tail -1 $OUT/R.summary)"; else fail "runner tests (rc $r; R.json/R.txt)"; fi
# ---- 5c Node 18 compatibility of the shipped JS (source scan; the guest node run itself stays unproven offline) ----
grep -nE 'toSorted|toReversed|toSpliced|Object\.groupBy|Map\.groupBy|withResolvers|Array\.fromAsync|isWellFormed|getBuiltinModule|import\.meta\.(dirname|filename)|with \{ *type|assert \{ *type' \
  $D/b/lib/bind_anchor.mjs $D/b/vendor/anchor-bootstrap.mjs $D/b/vendor/node_modules/@noble/hashes/*.js > $OUT/node18-scan.txt && fail "post-Node-18 API in shipped JS (node18-scan.txt)" || ok "no post-Node-18 API in shipped JS"
grep -q 'typeof Uint8Array.from(\[\]).toHex === .function. && typeof Uint8Array.fromHex === .function.' $D/b/vendor/node_modules/@noble/hashes/utils.js \
  && ok "noble hex builtins are feature-detected (fallback on Node 18)" || fail "noble hex builtin detection changed"
if [ -n "${HCAP_NODE18:-}" ]; then   # optional: root supplies a real Node 18 binary -> the anchored-origin suite runs on it
  case "$($HCAP_NODE18 --version)" in v18.*) (cd $T/case/tests && NODE=$HCAP_NODE18 PYTHONPATH=$T/case/tests timeout 1200 python3 -B run_all.py $OUT/N18.json $OUT/N18.txt 9 test_anchored_origin < /dev/null > $OUT/N18.summary 2>&1) \
    && ok "anchored-origin suite on Node $($HCAP_NODE18 --version)" || fail "Node 18 suite (N18.txt)";; *) fail "HCAP_NODE18 is not v18";; esac
else echo "note: HCAP_NODE18 not given; Node 18 execution remains unproven offline"; fi
# ---- 6 production copy and stage unchanged ----
$HC verify > /dev/null 2>&1 && ok "relocated production copy still verifies" || fail "relocated copy changed"
bash $S/tools/freeze.sh --check > /dev/null || fail "stage changed during the run"
echo "## outputs: $OUT"; echo "## bundleId $(sha256sum < $S/bundle/MANIFEST.json | cut -c1-64)"; echo "## historical-capture-offline rc=$rc"; exit $rc
