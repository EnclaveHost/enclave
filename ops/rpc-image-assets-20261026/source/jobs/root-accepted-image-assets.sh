#!/bin/bash
# accepted-image-assets-stage: ROOT job. The derived reader's measured-image assets on final-consumer r4 (tree 929fc19a):
# composed tree 5052bd58 = r4 + patches/accepted-image-assets-vs-r4.patch (2 added, 2 modified files). Modes:
#   check   (offline; 512)  : reproduce the composed tree; full metal-control-overlay test file; the 4 non-gated derived-reader
#                             tests must pass; skips must be exactly the 4 input-gated tests (2 chain verifier, 2 derived reader)
#   assets  (offline; 512)  : NATIVE HELIOS CHECKPOINT GLIBC_DIR -> verify every input against the committed pins, KVM's own
#                             readCheckpoint (refuses expired), then the 2 gated derived-reader tests with the real files
#   image   (root; writes OUT only): BASE OUT INPUTS [CHAIN_VERIFIER_DIR] -> overlay-control-image.py --control direct over the
#                             verified BASE; records the manifest. It does NOT compute/accept a measurement or qualify SNP.
#   jobs/q-exit-status.sh <n> 512 unshare -Urn bash accepted-image-assets-stage/jobs/root-accepted-image-assets.sh check
#   jobs/q-exit-status.sh <n> 512 unshare -Urn bash accepted-image-assets-stage/jobs/root-accepted-image-assets.sh assets NATIVE HELIOS CHECKPOINT GLIBC_DIR
#   jobs/q-exit-status.sh <n> 768 bash accepted-image-assets-stage/jobs/root-accepted-image-assets.sh image BASE OUT INPUTS [CHAIN_VERIFIER_DIR]
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/accepted-image-assets-stage; R4=$P/final-consumer-composition-stage/r4; CAND=$P/rpc-final-candidate-20261026/tree
BASE_TREE=929fc19a53e13a78d4d182f4eb969e76b619910d; NEW_TREE=5052bd58e8399f9d5040aef911b91ca8632a2501
MODE=${1:-}; shift || true
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$
die() { echo "## SETUP: $*" | tee -a $O/setup.txt; echo "## accepted-image-assets $MODE rc=9"; exit 9; }
mkdir -p $O/tmp || exit 9
case "$MODE" in check|assets|image) ;; *) die "mode must be check|assets|image";; esac
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ "$(sha256sum < $R4/SHA256SUMS | cut -c1-64)" = afd35070b0a9751727df307aadb01458866b9e298618461d71a7fdfb0a919a0c ] || die "r4 SHA256SUMS changed"
if [ "$MODE" != image ]; then ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"; fi
# the composed repo: r4's tree + the patch, as ONE commit (the overlay tool and its tests read the committed files)
REPO=$O/repo; mkdir -p $REPO
git --git-dir=$R4/git archive $BASE_TREE | tar -x -C $REPO || die "archive r4 tree"
(cd $REPO && git init -q && git apply --check $S/patches/accepted-image-assets-vs-r4.patch && git apply $S/patches/accepted-image-assets-vs-r4.patch \
  && git add -A && [ "$(git write-tree)" = $NEW_TREE ] && git -c user.name=root -c user.email=root@localhost commit -qm "accepted-image-assets $NEW_TREE") \
  > $O/compose.txt 2>&1 || die "composed tree is not $NEW_TREE"
ln -s "$(readlink -f $CAND/node_modules)" $REPO/node_modules
COMMIT=$(git -C $REPO rev-parse HEAD); echo "$COMMIT $NEW_TREE" > $O/commit.txt
runtests() {   # $1 tag, extra env
  local tag=$1; shift
  (cd $REPO && env -i PATH=$PATH HOME=$O/tmp TMPDIR=$O/tmp PYTHONDONTWRITEBYTECODE=1 "$@" timeout -k 5 900 python3 -I test/metal-control-overlay.test.py -v) \
    > $O/$tag.txt 2>&1; echo $? > $O/$tag.rc
}
verdict() {  # $1 tag $2 expected gated skips
  python3 -I - "$O/$1.txt" "$(cat $O/$1.rc)" "$2" <<'PY'
import re, sys
t, rc, want = open(sys.argv[1]).read(), int(sys.argv[2]), int(sys.argv[3])
res = dict(re.findall(r"^(test_\w+) \(__main__\.(?:\w+)\.test_\w+\) \.\.\. (ok|FAIL|ERROR|skipped.*)$", t, re.M))
lines = re.findall(r"^(test_\w+) \(__main__\.(\w+)\.\w+\) \.\.\. (ok|FAIL|ERROR|skipped[^\n]*)$", t, re.M)
dr = [(n, r) for n, c, r in lines if c == "DerivedReaderOverlay"]
skips = [(c, n) for n, c, r in lines if r.startswith("skipped")]
bad = [(c, n, r) for n, c, r in lines if r in ("FAIL", "ERROR")]
gated = {("ChainVerifierOverlay", "test_with_inputs_every_pinned_file_is_installed_with_its_mode_and_digest"),
         ("ChainVerifierOverlay", "test_a_native_file_that_is_not_the_pinned_one_refuses_and_writes_nothing"),
         ("DerivedReaderOverlay", "test_with_real_inputs_every_pinned_file_is_installed_in_the_control_image"),
         ("DerivedReaderOverlay", "test_with_real_inputs_a_changed_native_file_refuses_and_writes_nothing")}
ok = rc == 0 and not bad and len(dr) == 6 and len(skips) == want and set(skips) <= gated and re.search(r"^OK", t, re.M)
print({"ok": bool(ok), "rc": rc, "tests": len(lines), "failed": bad, "derivedReader": dr, "skipped": skips})
sys.exit(0 if ok else 1)
PY
}
case "$MODE" in
check)
  runtests check
  verdict check 4 | tee $O/verdict.txt; exit ${PIPESTATUS[0]} ;;
assets)
  [ $# = 4 ] || die "assets NATIVE HELIOS CHECKPOINT GLIBC_DIR"
  IN=$O/inputs; mkdir -p $IN
  cp -- "$1" $IN/derivation_harness_lease_v3 && cp -- "$2" $IN/helios && cp -- "$3" $IN/checkpoint.json || die "copy inputs"
  for f in ld-linux-x86-64.so.2 libc.so.6 libm.so.6 libgcc_s.so.1; do cp -- "$4/$f" $IN/$f || die "glibc $f"; done
  python3 -I - $REPO/metal/derived-reader-image.json $IN <<'PY' | tee $O/inputs.txt || die "an input is not the pinned file"
import hashlib, json, os, sys
p, d = json.load(open(sys.argv[1])), sys.argv[2]
want = {os.path.basename(v["path"]): v["sha256"] for v in [*p["binaries"].values(), *p["files"].values()]}
want.update(p["glibcRuntime"]["files"])
bad = {n: hashlib.sha256(open(os.path.join(d, n), "rb").read()).hexdigest() for n in want}
bad = {n: h for n, h in bad.items() if h != want[n]}
print({"inputs": sorted(want), "mismatch": bad}); sys.exit(1 if bad else 0)
PY
  (cd $REPO && env -i PATH=$PATH HOME=$O/tmp node --input-type=module -e "
    import { readCheckpoint } from './network/derived-reader/l1-runtime.mjs';
    const c = readCheckpoint('$IN/checkpoint.json'); console.log(JSON.stringify({ checkpoint: c.digest, slot: c.slot,
      expiresUtc: new Date((c.timestamp + 604800) * 1000).toISOString() }));") > $O/checkpoint.txt 2>&1 \
    || { cat $O/checkpoint.txt; die "KVM's readCheckpoint refuses the checkpoint (expired, not reviewed or malformed)"; }
  cat $O/checkpoint.txt
  runtests assets DERIVED_READER_INPUTS=$IN
  verdict assets 2 | tee $O/verdict.txt; exit ${PIPESTATUS[0]} ;;
image)
  [ $# = 3 ] || [ $# = 4 ] || die "image BASE OUT INPUTS [CHAIN_VERIFIER_DIR]"
  [ ! -e "$2" ] || die "OUT exists (never overwritten)"
  CV=(); [ $# = 4 ] && CV=(--chain-verifier-dir "$4")
  (cd $REPO && python3 -I metal/overlay-control-image.py --control direct "${CV[@]}" --derived-reader-dir "$3" "$1" "$2" "$COMMIT") > $O/overlay.txt 2>&1 \
    || { cat $O/overlay.txt; die "overlay refused"; }
  python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1])); r=m["controlOverlay"]["derivedReader"]; assert r["installed"] is True, r; print(json.dumps({"initramfs": m["initramfs"], "derivedReader": r}, indent=1))' "$2/manifest.json" | tee $O/image.txt \
    || die "the image does not record the installed derived reader"
  echo "NEXT (root, existing process): compute the expected SNP measurement for $2 and qualify it; nothing here accepts a measurement." ;;
esac
