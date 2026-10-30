#!/bin/bash
# writer-driver-stage/r1: ROOT job (prepared by Claude, NOT run by Claude). The single-native-slot driver (relay/derived-reader-driver.mjs)
# and its fake-provider/clock/timer suite (test/derived-reader-driver.test.mjs, exactly 10 tests) on the frozen writer-two-anchor r3
# source: r9 release 296a5833 + r1 (f22d554c) + r2 (20d0d76a) + r3 (5f141c3f) + patches/writer-driver-r1-vs-writer-two-anchor-r3.patch
# = e5260035 (two NEW files; no existing file changed, asserted). Fixtures only: no reader, native, witness, network or live action;
# no duration is a performance claim. The driver is wired into nothing (defaults unchanged).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh writer-driver-r1 512 unshare -Urnm bash writer-driver-stage/r1/jobs/root-writer-driver-r1.sh
# ENVIRONMENT: never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP; writes only under $OUT.
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/writer-driver-stage/r1; W3=$P/writer-two-anchor-stage/r3; W2=$P/writer-two-anchor-stage/r2; W1=$P/writer-two-anchor-stage/r1
R9=$P/accepted-image-enrollment-stage/r9; R9RUN=$R9/runs/20261026T165416Z-check-2058632
R9_SUMS=528ff8e8b91c5e563c640c7aed77d6662e82331c7923cfbe916514adbc08b2ec
BASE_COMMIT=296a583331b638a430f72929648ebf26d86522d3; BASE_TREE=90e4cdaada85825f15bccc8bf9df07bf418da9bf; BASE_SRC_TREE=68245755168b13bb47041bce54ad5fb7cd0b89da
W1_SUMS=cdacd616e3b217d6450c768b1a2cc520d6000aee719cddd064502297a37ae0b9; W1_TREE=f22d554c04f959a56d993f1c5048cd9e06a2d4b0
W2_SUMS=3dba09e6700a4a8d6cbfb00b6ee70630b1318e5e3822a537d5e3e585e2922fe2; W2_TREE=20d0d76a98da84622b98991547dc07fb2fe39e3e
W3_SUMS=5ca6754e1117ee442e00ee1854db1f814fafdf58dd2fc72c38e36cd91abe0f7a; W3_TREE=5f141c3fa476b904d6a0107a75c31c9113726591
NEW_TREE=e5260035d70f057fb0237e773f58b70f63210674
PATCH1=$W1/patches/writer-two-anchor-r1-vs-r9-release.patch; PATCH2=$W2/patches/writer-two-anchor-r2-vs-r1.patch
PATCH3=$W3/patches/writer-two-anchor-r3-vs-r2.patch; PATCHD=$S/patches/writer-driver-r1-vs-writer-two-anchor-r3.patch
T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; L=$OUT/logs; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*" | tee -a $OUT/setup.txt; echo "## writer-driver-r1 rc=9"; exit 9; }
[ ! -e "$OUT" ] && mkdir -p $L $OUT/tmp || { echo "output dir"; exit 9; }
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urnm"
mount --make-rprivate / 2>/dev/null || die "no private mount namespace: run under unshare -Urnm"
# 0. frozen inputs
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "driver r1 stage != SHA256SUMS"
for x in "$W3 $W3_SUMS" "$W2 $W2_SUMS" "$W1 $W1_SUMS" "$R9 $R9_SUMS"; do set -- $x
  [ "$(sha256sum < $1/SHA256SUMS | cut -c1-64)" = $2 ] && (cd $1 && sha256sum -c --quiet SHA256SUMS) || die "frozen stage $1 changed"; done
python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); r=v["release"]; assert v["ok"] is True and v["mode"] == "check" and r["commit"] == sys.argv[2] and r["tree"] == sys.argv[3] and r["sourceTree"] == sys.argv[4]' \
  $R9RUN/verdict.json $BASE_COMMIT $BASE_TREE $BASE_SRC_TREE || die "the r9 run is not the qualified check verdict for $BASE_COMMIT"
[ "$(cat $R9RUN/stage-sums.sha256)" = $R9_SUMS ] || die "the r9 run was made by other r9 stage bytes"
sha256sum < $S/SHA256SUMS | cut -c1-64 > $OUT/stage-sums.sha256
bindro() { local src=$1 dst=$2; [ -d "$src" ] || return 0; mkdir -p $dst && mount --bind "$src" $dst && mount -o remount,bind,ro $dst || die "bind $src"; }
cleanup() { for d in relay/node_modules network/node_modules node_modules; do umount $OUT/repo/$d 2>/dev/null || true; done; }
trap cleanup EXIT
export PATH=/usr/bin:/bin
# 1. compose, every tree asserted; the driver patch adds exactly two new files
REPO=$OUT/repo
git clone -q --no-hardlinks $R9RUN/release.git $REPO && git -C $REPO checkout -q $BASE_COMMIT || die "r9 release checkout"
[ "$(git -C $REPO rev-parse HEAD^{tree})" = $BASE_TREE ] || die "r9 release tree"
(cd $REPO && git apply --index $PATCH1 && git add -f -A && [ "$(git write-tree)" = $W1_TREE ] \
  && git apply --index $PATCH2 && git add -f -A && [ "$(git write-tree)" = $W2_TREE ] \
  && git apply --index $PATCH3 && git add -f -A && [ "$(git write-tree)" = $W3_TREE ] \
  && git apply --index $PATCHD && git add -f -A && [ "$(git write-tree)" = $NEW_TREE ] \
  && [ "$(git diff --cached --name-status $W3_TREE | LC_ALL=C sort | tr '\t' ' ')" = "$(printf 'A relay/derived-reader-driver.mjs\nA test/derived-reader-driver.test.mjs')" ] \
  && git -c user.name=root -c user.email=root@localhost commit -qm "writer-driver r1 on writer-two-anchor r3 $W3_TREE") > $L/compose.txt 2>&1 \
  || die "composed tree is not $W1_TREE / $W2_TREE / $W3_TREE / $NEW_TREE, or the driver patch changed an existing file"
SRC_COMMIT=$(git -C $REPO rev-parse HEAD)
# 2. the qualified dependency tree, bound READ-ONLY (locks equal)
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] && [ -z "$(git -C $T status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $T/package-lock.json | cut -c1-64)" = $LOCK ] || die "node_modules identity"
for d in . network relay; do cmp -s $T/$d/package-lock.json $REPO/$d/package-lock.json 2>/dev/null || [ ! -e $T/$d/package-lock.json ] || die "$d lock != the dependency tree's lock"
  bindro "$(readlink -f $T/$d/node_modules)" $REPO/$d/node_modules; done
# 3. the driver suite (exact count)
(cd $REPO && env -i PATH=$PATH NODE_OPTIONS=--max-old-space-size=256 timeout -k 10 300 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 \
   test/derived-reader-driver.test.mjs < /dev/null) > $L/driver.tap 2>&1; echo $? > $L/driver.rc
cleanup
python3 -I - "$L" "$SRC_COMMIT" "$NEW_TREE" <<'PY' > $OUT/verdict.json; rc=$?
import json, re, sys, pathlib
L, src, tree = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
s = (L / "driver.tap").read_text(errors="replace"); r = int((L / "driver.rc").read_text())
c = {"rc": r, **{k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}}
ok = r == 0 and c.get("tests") == 10 and c.get("pass") == 10 and not any(c.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
print(json.dumps({"sourceCommit": src, "sourceTree": tree, "tests": {"driver": {**c, "expected": 10, "ok": ok}}, "ok": ok,
  "scope": "SOURCE + FIXTURES: the single-native-slot driver against a fake provider, clock and timers. No reader, native executable, witness "
           "producer, network or measured duration; NOT a performance, availability or S <= 120 s claim; wired into no startup."}, indent=1))
sys.exit(0 if ok else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/repo $OUT/tmp
cat $OUT/verdict.json; echo "## outputs: $OUT"; echo "## writer-driver-r1 rc=$rc"; exit $rc
