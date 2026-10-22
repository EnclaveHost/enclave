#!/bin/sh
# COMBINED Linux control release (immutable; v2 = v1 + the overlay symlink fix as ONE child commit; fresh stage2/; adapted from the proven linux-post-adoption-release/job-stage-release.sh).
# No production mutation, nothing written in main. Source: MAIN's working tree (work/enclave: HEAD e762a9c5 + its dirty
# paths, incl. owner nomination, TOKENS? credential exclusion, pinned relay transport and the three regenerated bundles),
# captured into a NEW scratch commit (child of HEAD, in a bare CLONE of main's .git; main's tree hash must be identical
# before and after the capture). Then: the release dir (git archive, no node_modules); the commit's OWN
# metal/overlay-control-image.py over the read-only production base dist-sdshield-2857356cd; imports from the image; the
# production recipe reproduces production's b8376e15 and the KEPT ed918e4b before measuring the new image; the image vs
# the KEPT image entry by entry (only app/ and opt/metal/ may differ, and every changed app/opt-metal file must be the
# source's bytes); launcher-check with the archived launcher; the owner config through the image's own checker.
# v1 (stage/, logs/stage-combined-v1.log) failed at the image import check: the overlay installed the git symlink
# relay/net-guard.mjs (-> ../net-guard.mjs, newly in the supervisor closure) as its link text. v2 captures main as v1 did
# (commit A), then commit B = A + overlay-fix/new/{metal/overlay-control-image.py,test/metal-control-overlay.test.py}
# (the tool installs a link's in-repo target bytes, as build-image.mjs's copyFileSync does); the release is B.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; L=$W/linux-combined-release; S=$L/stage2; F=$L/overlay-fix
K=$W/linux-post-adoption-release/stage; KI=$K/dist-leasegas-deabf8f90; KR=$K/metal-deabf8f90
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
[ ! -e "$S" ] || { echo "stage2 already attempted; inspect before retry"; exit 2; }
for b in overlay-control-image.py:metal/overlay-control-image.py metal-control-overlay.test.py:test/metal-control-overlay.test.py; do
  [ "$(sha256sum < $F/base/${b%%:*} | cut -c1-64)" = "$(sha256sum < $M/${b#*:} | cut -c1-64)" ] || { echo "CONTENTION: main's ${b#*:} moved from overlay-fix/base; not staging"; exit 3; }
done; echo "MAIN-OVERLAY-TOOL-IS-THE-FIX-BASE"
mkdir -p $S; for h in extract.py import-check.mjs launcher-check.mjs; do cmp $L/stage/$h $W/linux-post-adoption-release/stage/$h; cp $L/stage/$h $S/; done
[ "$(cat $KI/MEASUREMENT)" = ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2 ] || { echo "KEPT image changed"; exit 2; }
diff -rq --no-dereference /home/steven/enclave-prod/metal-deabf8f90 $KR >/dev/null && diff -rq /home/steven/enclave-prod/dist-leasegas-deabf8f90 $KI >/dev/null && echo "KEPT-LOCAL == PRODUCTION-STAGED (release and image)" || { echo "KEPT local copies differ from production's staged ones"; exit 2; }
treehash() { (cd "$M" && find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum); }
treehash > $L/main-capture-v2-before.sha256
git clone -q --bare --no-hardlinks "$M/.git" "$S/scratch.git"
export GIT_DIR=$S/scratch.git GIT_WORK_TREE=$M
PARENT=$(git rev-parse HEAD)
[ "$PARENT" = e762a9c5f523cf7fcb6d68118ca459290926f8fa ] || { echo "unexpected main HEAD $PARENT"; exit 2; }
git read-tree "$PARENT"
(cd "$M" && git -c core.autocrlf=false add -A -- .)   # from inside main: the index lives in the scratch GIT_DIR, main is only read
git -c user.name=stage -c user.email=stage@localhost commit -q -m "linux combined release: owner nomination + TOKENS? exclusion + pinned relay + regenerated bundles (SCRATCH capture of main's working tree, not main)"
A=$(git rev-parse HEAD); echo "SCRATCH-COMMIT-A $A parent $PARENT"
treehash > $L/main-capture-v2-after.sha256
cmp -s $L/main-capture-v2-before.sha256 $L/main-capture-v2-after.sha256 && echo "MAIN-STABLE-DURING-CAPTURE" || { echo "MAIN CHANGED DURING CAPTURE: not staging"; exit 1; }
unset GIT_WORK_TREE
cmp -s $L/main-capture-after.sha256 $L/main-capture-v2-after.sha256 && echo "MAIN-UNCHANGED-SINCE-V1-CAPTURE" || echo "MAIN-MOVED-SINCE-V1-CAPTURE $(diff $L/main-capture-after.sha256 $L/main-capture-v2-after.sha256 | grep -c '^[<>]') lines (see main-capture-*.sha256)"
export GIT_INDEX_FILE=$S/fix.index
git read-tree $A
for p in metal/overlay-control-image.py test/metal-control-overlay.test.py; do
  mode=$(git ls-tree $A -- $p | cut -d' ' -f1); blob=$(git hash-object -w $F/new/$p)
  git update-index --cacheinfo $mode,$blob,$p
done
COMMIT=$(git -c user.name=stage -c user.email=stage@localhost commit-tree $(git write-tree) -p $A -m "overlay: install a git symlink's in-repo target bytes (build-image.mjs copyFileSync parity), never the link text")
unset GIT_INDEX_FILE; rm -f $S/fix.index
[ "$(git diff --name-only $A $COMMIT | tr '\n' ' ')" = "metal/overlay-control-image.py test/metal-control-overlay.test.py " ] || { echo "B changes more than the fix"; exit 1; }
SHORT=$(echo $COMMIT | cut -c1-9); echo "SCRATCH-COMMIT-B $COMMIT parent $A (only the overlay fix)"
git diff --name-status "$PARENT" "$COMMIT" > $L/commit-delta-v2-vs-head.txt; echo "COMMIT-DELTA-VS-HEAD $(wc -l < $L/commit-delta-v2-vs-head.txt) paths"
for f in supervisor.js client/lease-executor-client.mjs network/lease-gas-runtime.mjs network/lease-gas-conduit.mjs network/host-owner-nomination.mjs metal/guest/owner-nomination.mjs metal/guest/measured-control.mjs metal/guest/gsup.mjs metal/enclave-metal.mjs metal/guest/lease-gas-conduit.bundle.mjs metal/guest/platform-api.bundle.mjs windows/node/lease-gas-runtime.bundle.mjs; do
  [ "$(git show $COMMIT:$f | sha256sum | cut -c1-64)" = "$(sha256sum < $M/$f | cut -c1-64)" ] || { echo "COMMIT $f != main"; exit 1; }
done; echo COMMIT-CARRIES-THE-COMPOSITION-BYTES
R=$S/metal-$SHORT
mkdir -p $R; git archive $COMMIT | tar -x -C $R
[ ! -e $R/node_modules ] && echo "RELEASE-NO-NODE_MODULES" || { echo RELEASE-HAS-NODE_MODULES; exit 1; }
ln -sfn stage2/metal-$SHORT $L/tree      # the stage helpers read ../tree (the release's own sources)
diff -rq --no-dereference $KR $R > $L/release-delta-v2-vs-kept.txt || true
echo "RELEASE-DELTA-VS-KEPT $(wc -l < $L/release-delta-v2-vs-kept.txt) lines"
OUT=$S/dist-leasegas-$SHORT
python3 $R/metal/overlay-control-image.py $BASE $OUT $COMMIT
echo OVERLAY-STAGED $OUT
python3 $S/extract.py $OUT/initramfs.cpio.gz $S/extract
node $S/import-check.mjs $S/extract
cmp $S/extract/app/relay/net-guard.mjs $R/net-guard.mjs && echo "SYMLINK-INSTALLED-AS-TARGET-BYTES app/relay/net-guard.mjs == net-guard.mjs"
CUR=$($MEASURE "$APPEND" --kernel $BASE/vmlinuz --initrd $BASE/initramfs.cpio.gz --output-format hex)
[ "$CUR" = "$(cat $BASE/MEASUREMENT)" ] && echo "MEASURE-RECIPE-REPRODUCES-PRODUCTION $CUR" || { echo MEASURE-RECIPE-MISMATCH; exit 1; }
PREV=$($MEASURE "$APPEND" --kernel $KI/vmlinuz --initrd $KI/initramfs.cpio.gz --output-format hex)
[ "$PREV" = "$(cat $KI/MEASUREMENT)" ] && echo "MEASURE-RECIPE-REPRODUCES-KEPT $PREV" || { echo MEASURE-KEPT-MISMATCH; exit 1; }
NEW=$($MEASURE "$APPEND" --kernel $OUT/vmlinuz --initrd $OUT/initramfs.cpio.gz --output-format hex)
echo "$NEW" > $OUT/MEASUREMENT
echo "MEASURE-STAGED $NEW"
sha256sum $OUT/initramfs.cpio.gz $OUT/vmlinuz $OUT/cmdline $OUT/manifest.json $OUT/MEASUREMENT
cmp -s $OUT/vmlinuz $KI/vmlinuz && cmp -s $OUT/cmdline $KI/cmdline && cmp -s $OUT/vmlinuz $BASE/vmlinuz && echo "KERNEL-CMDLINE-SAME-AS-KEPT-AND-PRODUCTION" || { echo KERNEL-OR-CMDLINE-DIFFERS; exit 1; }
python3 - $KI/initramfs.cpio.gz $OUT/initramfs.cpio.gz $R $L/image-delta-v2-vs-kept.json <<'PY'
import gzip,hashlib,importlib.util,sys,json,os
spec=importlib.util.spec_from_file_location('o',sys.argv[3]+'/metal/overlay-control-image.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
def index(p):
    r={}
    with gzip.open(p,'rb') as f:
        for key,name,fields,header in o.entries(f):
            d=o.exact(f,fields[6]);o.exact(f,-fields[6]%4)
            r[key]=(hashlib.sha256(d).hexdigest(),tuple(fields[1:6]))
    return r
a,b=index(sys.argv[1]),index(sys.argv[2])
changed=sorted(k for k in set(a)&set(b) if a[k]!=b[k]); added=sorted(set(b)-set(a)); removed=sorted(set(a)-set(b))
json.dump({'changed':changed,'added':added,'removed':removed,'entries':[len(a),len(b)]},open(sys.argv[4],'w'),indent=1)
print('IMAGE-ENTRIES',len(a),len(b),'CHANGED',len(changed),'ADDED',len(added),'REMOVED',len(removed))
for k in changed+added: print('  ',('changed' if k in a else 'added'),k)
for k in removed: print('   removed',k)
bad=[k for k in changed+added+removed if not (k.startswith('app/') or k.startswith('opt/metal/'))]
if bad: sys.exit('IMAGE-DELTA-OUTSIDE-APP-AND-OPT-METAL '+repr(bad))
src=lambda k: sys.argv[3]+'/'+k[4:] if k.startswith('app/') else sys.argv[3]+'/metal/guest/'+k[len('opt/metal/'):]
mism=[k for k in changed+added if k!='opt/metal/manifest.json' and not k.endswith('/') and os.path.isfile(src(k)) and hashlib.sha256(open(src(k),'rb').read()).hexdigest()!=b[k][0]]
nosrc=[k for k in changed+added if k!='opt/metal/manifest.json' and not os.path.isfile(src(k))]
if mism: sys.exit('IMAGE-FILE-NOT-SOURCE '+repr(mism))
print('IMAGE-DELTA-WITHIN-APP-AND-OPT-METAL; every changed/added file is the release source bytes'+(' (no source path for: '+repr(nosrc)+')' if nosrc else ''))
PY
for f in owner-nomination.mjs lease-gas-conduit.bundle.mjs platform-api.bundle.mjs measured-control.mjs gsup.mjs; do cmp -s $S/extract/opt/metal/$f $R/metal/guest/$f && echo "OPT-METAL-IS-SOURCE $f" || { echo "OPT-METAL-DIFFERS $f"; exit 1; }; done
for f in supervisor.js metal/guest/owner-nomination.mjs network/host-owner-nomination.mjs client/lease-executor-client.mjs network/lease-gas-runtime.mjs; do cmp -s $S/extract/app/$f $R/$f && echo "APP-IS-SOURCE $f" || { echo "APP-DIFFERS $f"; exit 1; }; done
node $S/launcher-check.mjs $R $S/extract
node --input-type=module -e 'import fs from "node:fs"; const { checkOwnerNomination } = await import(process.argv[1]); const n = checkOwnerNomination(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))); console.log("OWNER-CONFIG-OK-BY-IMAGE-CHECKER", n.ownershipContract, n.owner);' "$S/extract/app/metal/guest/owner-nomination.mjs" "$L/metal0-owner-nomination.json"
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files)"
echo STAGE-COMBINED-OK
