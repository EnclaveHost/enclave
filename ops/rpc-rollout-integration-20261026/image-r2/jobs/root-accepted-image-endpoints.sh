#!/bin/bash
# accepted-image-assets-stage/r2: ROOT job. The derived reader's endpoint/config transport on final-consumer r4:
# composed tree c0a5f4e461f6383ced0fbc01e8b1a7569ded63c8 = r4 929fc19a + r1 patch (tree 5052bd58, stage SUMS 2210d3e3, FROZEN) + patches/accepted-image-assets-r2-vs-r1.patch.
#   check (offline; 768): the new endpoint tests (bind/compose/relay env/transport refusals; 6 tests), the overlay test file
#                         (6 derived-reader tests, skips exactly the 4 input-gated ones) and the affected existing node suites
#   image (root; writes OUT only): BASE OUT INPUTS [CHAIN_VERIFIER_DIR] -> the r1 image step on the r2 tree; no measurement.
#   jobs/q-exit-status.sh <n> 768 unshare -Urn bash accepted-image-assets-stage/r2/jobs/root-accepted-image-endpoints.sh check
#   jobs/q-exit-status.sh <n> 768 bash accepted-image-assets-stage/r2/jobs/root-accepted-image-endpoints.sh image BASE OUT INPUTS [CHAIN_VERIFIER_DIR]
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S1=$P/accepted-image-assets-stage; S=$S1/r2; R4=$P/final-consumer-composition-stage/r4; CAND=$P/rpc-final-candidate-20261026/tree
BASE_TREE=929fc19a53e13a78d4d182f4eb969e76b619910d; R1_TREE=5052bd58e8399f9d5040aef911b91ca8632a2501
NEW_TREE=c0a5f4e461f6383ced0fbc01e8b1a7569ded63c8
MODE=${1:-}; shift || true
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$
die() { echo "## SETUP: $*" | tee -a $O/setup.txt; echo "## accepted-image-endpoints $MODE rc=9"; exit 9; }
mkdir -p $O/tmp || exit 9
case "$MODE" in check|image) ;; *) die "mode must be check|image";; esac
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r2 stage != SHA256SUMS"
[ "$(sha256sum < $S1/SHA256SUMS | cut -c1-64)" = 2210d3e35d3d9f02a9fe0311f39ebe86f551bbd98b856f43e36a4df1db59c245 ] || die "r1 SHA256SUMS changed"
(cd $S1 && sha256sum -c --quiet SHA256SUMS) || die "r1 stage != its SHA256SUMS"
[ "$(sha256sum < $R4/SHA256SUMS | cut -c1-64)" = afd35070b0a9751727df307aadb01458866b9e298618461d71a7fdfb0a919a0c ] || die "r4 SHA256SUMS changed"
if [ "$MODE" = check ]; then ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -v '^local\|127.0.0.0/8' | grep -q . && die "network route present: run under unshare -Urn"; fi
REPO=$O/repo; mkdir -p $REPO
git --git-dir=$R4/git archive $BASE_TREE | tar -x -C $REPO || die "archive r4 tree"
(cd $REPO && git init -q && git apply $S1/patches/accepted-image-assets-vs-r4.patch && git add -A && [ "$(git write-tree)" = $R1_TREE ] \
  && git apply $S/patches/accepted-image-assets-r2-vs-r1.patch && git add -A && [ "$(git write-tree)" = $NEW_TREE ] \
  && git -c user.name=root -c user.email=root@localhost commit -qm "accepted-image-endpoints $NEW_TREE") > $O/compose.txt 2>&1 || die "composed tree is not $NEW_TREE"
ln -s "$(readlink -f $CAND/node_modules)" $REPO/node_modules
COMMIT=$(git -C $REPO rev-parse HEAD); echo "$COMMIT $NEW_TREE" > $O/commit.txt
nodetest() {  # $1 tag, files...: node:test, every file must pass
  local tag=$1; shift
  (cd $REPO && env -i PATH=$PATH HOME=$O/tmp TMPDIR=$O/tmp timeout -k 5 1200 node --test --test-reporter=tap "$@") > $O/$tag.txt 2>&1; echo $? > $O/$tag.rc
  echo "{\"$tag\": {\"rc\": $(cat $O/$tag.rc), $(grep -E '^# (tests|pass|fail|skipped|cancelled) ' $O/$tag.txt | sed -E 's/^# (\w+) ([0-9]+)/"\1": \2/' | paste -sd, -)}}"
}
case "$MODE" in
check)
  RC=0
  nodetest endpoints test/derived-reader-endpoints.test.mjs | tee $O/endpoints.json
  grep -q '^# pass 6$' $O/endpoints.txt && grep -q '^# fail 0$' $O/endpoints.txt && [ "$(cat $O/endpoints.rc)" = 0 ] || RC=1
  (cd $REPO && env -i PATH=$PATH HOME=$O/tmp TMPDIR=$O/tmp PYTHONDONTWRITEBYTECODE=1 timeout -k 5 900 python3 -I test/metal-control-overlay.test.py -v) > $O/overlay.txt 2>&1; echo $? > $O/overlay.rc
  python3 -I - $O/overlay.txt "$(cat $O/overlay.rc)" <<'PY' | tee $O/overlay-verdict.txt || RC=1
import re, sys
t, rc = open(sys.argv[1]).read(), int(sys.argv[2])
lines = re.findall(r"^(test_\w+) \(__main__\.(\w+)\.\w+\) \.\.\. (ok|FAIL|ERROR|skipped[^\n]*)$", t, re.M)
dr = [(n, r) for n, c, r in lines if c == "DerivedReaderOverlay"]; skips = [(c, n) for n, c, r in lines if r.startswith("skipped")]
bad = [(c, n, r) for n, c, r in lines if r in ("FAIL", "ERROR")]
ok = rc == 0 and not bad and len(dr) == 6 and len(skips) == 4 and all(c in ("ChainVerifierOverlay", "DerivedReaderOverlay") and "with" in n for c, n in skips) and re.search(r"^OK", t, re.M)
print({"ok": bool(ok), "rc": rc, "tests": len(lines), "failed": bad, "derivedReader": dr, "skipped": skips}); sys.exit(0 if ok else 1)
PY
  # the affected existing suites (platform API config/role, the derived writer authority and reader runtime): unchanged behaviour
  AFFECTED=$(cd $REPO && ls test/platform-api-*.test.mjs test/derived-writer-authority*.test.mjs test/relay-derived-reader-runtime.test.mjs test/derived-reader.test.mjs)
  nodetest affected $AFFECTED | tee $O/affected.json
  grep -q '^# fail 0$' $O/affected.txt && [ "$(cat $O/affected.rc)" = 0 ] || RC=1
  echo "NOTE: offline; no chain, no SNP and no image are claimed. NEXT (root): regenerate the platform-api guest bundle from this tree with the existing bundler."
  echo "## accepted-image-endpoints check rc=$RC"; exit $RC ;;
image)
  [ $# = 3 ] || [ $# = 4 ] || die "image BASE OUT INPUTS [CHAIN_VERIFIER_DIR]"
  [ ! -e "$2" ] || die "OUT exists (never overwritten)"
  CV=(); [ $# = 4 ] && CV=(--chain-verifier-dir "$4")
  (cd $REPO && python3 -I metal/overlay-control-image.py --control direct "${CV[@]}" --derived-reader-dir "$3" "$1" "$2" "$COMMIT") > $O/overlay.txt 2>&1 \
    || { cat $O/overlay.txt; die "overlay refused"; }
  python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); r=m["controlOverlay"]["derivedReader"]; assert r["installed"] is True and "roleEnv" in r, r; print(json.dumps({"initramfs": m["initramfs"], "derivedReader": r}, indent=1))' "$2/manifest.json" | tee $O/image.txt \
    || die "the image does not record the installed derived reader"
  echo "NEXT (root, existing process): compute the expected SNP measurement for $2 and qualify it; nothing here accepts a measurement." ;;
esac
