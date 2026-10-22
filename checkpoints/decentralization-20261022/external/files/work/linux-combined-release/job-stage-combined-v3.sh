#!/bin/sh
# FINAL COMBINED Linux control release (immutable; v3; fresh stage3/; stage/ (v1 failed proof) and stage2/ (v2) preserved).
# Source = main's working tree, which now carries root's integration of the overlay symlink fix (7a120502/3eefe941) and the
# regenerated host-admission/host-policy bundles (e83515fc/8b2dfbc6), so NO extra commit: the release is the exact capture.
# Same proven pipeline as v2 (job-stage-combined-v2.sh): capture into a bare CLONE of main's .git (main's tree hash identical
# before/after), git archive, the commit's own overlay tool over the read-only production base, image import check, the
# production recipe reproduces b8376e15 and KEPT ed918e4b before measuring, entry-by-entry delta vs KEPT and vs stage2,
# every overlaid file == manifest == release source, launcher-check, owner config through the image's checker.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; M=$W/enclave; L=$W/linux-combined-release; S=$L/stage3
K=$W/linux-post-adoption-release/stage; KI=$K/dist-leasegas-deabf8f90; KR=$K/metal-deabf8f90; S2I=$L/stage2/dist-leasegas-d05104403
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
[ ! -e "$S" ] || { echo "stage3 already attempted; inspect before retry"; exit 2; }
want() { [ "$(sha256sum < $M/$1 | cut -c1-64)" = "$2" ] || { echo "CONTENTION/MOVED: main $1 is not $2; not staging"; exit 3; }; }
want metal/overlay-control-image.py 7a120502034f2c7f70930355dab1357ac9e4816188993a5601a69abd36a7159c
want test/metal-control-overlay.test.py 3eefe9411fcb90b26a2687d4820f403f0bb8aaaece5683ad8a61efbfa2030b9d
want windows/node/host-admission.bundle.mjs e83515fca7468d5d6636631617d73d9ed9ef12b798439e7aaed347f2f524182c
want metal/guest/host-policy.bundle.mjs 8b2dfbc6b5466d3c4f4559c15d874824f1ddddd3e530667a3848b3141b477af9
(cd $M && sha256sum -c --quiet $L/generated-after.sha256) && echo "MAIN-HAS-ROOT-OVERLAY-FIX + REGENERATED-POLICY-BUNDLES + THE-SIX-GENERATED" || { echo "a regenerated bundle moved; not staging"; exit 3; }
[ "$(cat $KI/MEASUREMENT)" = ed918e4b393699b3f6251853d2d34317869d7d9e3150b41ffa917df3d392012c682f376a799494d01e6a6dd5bedd2ac2 ] || { echo "KEPT image changed"; exit 2; }
diff -rq --no-dereference /home/steven/enclave-prod/metal-deabf8f90 $KR >/dev/null && diff -rq /home/steven/enclave-prod/dist-leasegas-deabf8f90 $KI >/dev/null && echo "KEPT-LOCAL == PRODUCTION-STAGED (release and image)" || { echo "KEPT local copies differ from production's staged ones"; exit 2; }
mkdir -p $S; for h in extract.py import-check.mjs launcher-check.mjs; do cmp $L/stage/$h $W/linux-post-adoption-release/stage/$h; cp $L/stage/$h $S/; done
treehash() { (cd "$M" && find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum); }
treehash > $L/main-capture-v3-before.sha256
git clone -q --bare --no-hardlinks "$M/.git" "$S/scratch.git"
export GIT_DIR=$S/scratch.git GIT_WORK_TREE=$M
PARENT=$(git rev-parse HEAD)
[ "$PARENT" = e762a9c5f523cf7fcb6d68118ca459290926f8fa ] || { echo "unexpected main HEAD $PARENT"; exit 2; }
git read-tree "$PARENT"
(cd "$M" && git -c core.autocrlf=false add -A -- .)
git -c user.name=stage -c user.email=stage@localhost commit -q -m "linux combined release (final): owner nomination + TOKENS? exclusion + pinned relay + overlay symlink fix + regenerated bundles (SCRATCH capture of main's working tree, not main)"
COMMIT=$(git rev-parse HEAD); SHORT=$(echo $COMMIT | cut -c1-9); echo "SCRATCH-COMMIT $COMMIT parent $PARENT"
treehash > $L/main-capture-v3-after.sha256
cmp -s $L/main-capture-v3-before.sha256 $L/main-capture-v3-after.sha256 && echo "MAIN-STABLE-DURING-CAPTURE" || { echo "MAIN CHANGED DURING CAPTURE: not staging"; exit 1; }
git diff --name-status "$PARENT" "$COMMIT" > $L/commit-delta-v3-vs-head.txt; echo "COMMIT-DELTA-VS-HEAD $(wc -l < $L/commit-delta-v3-vs-head.txt) paths"
unset GIT_WORK_TREE
diff $L/main-capture-v2-after.sha256 $L/main-capture-v3-after.sha256 | grep '^[<>]' | awk '{print $3}' | sort -u > $L/main-delta-v2-to-v3.txt || true
echo "MAIN-PATHS-CHANGED-SINCE-V2-CAPTURE $(tr '\n' ' ' < $L/main-delta-v2-to-v3.txt)"
for f in supervisor.js client/lease-executor-client.mjs network/lease-gas-runtime.mjs network/lease-gas-conduit.mjs network/host-owner-nomination.mjs metal/guest/owner-nomination.mjs metal/guest/measured-control.mjs metal/guest/gsup.mjs metal/enclave-metal.mjs metal/guest/lease-gas-conduit.bundle.mjs metal/guest/platform-api.bundle.mjs windows/node/lease-gas-runtime.bundle.mjs windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs metal/overlay-control-image.py network/platform-host-policy-config.mjs; do
  [ "$(git show $COMMIT:$f | sha256sum | cut -c1-64)" = "$(sha256sum < $M/$f | cut -c1-64)" ] || { echo "COMMIT $f != main"; exit 1; }
done; echo COMMIT-CARRIES-THE-COMPOSITION-BYTES
R=$S/metal-$SHORT
mkdir -p $R; git archive $COMMIT | tar -x -C $R
[ ! -e $R/node_modules ] && echo "RELEASE-NO-NODE_MODULES" || { echo RELEASE-HAS-NODE_MODULES; exit 1; }
ln -sfn stage3/metal-$SHORT $L/tree      # the stage helpers read ../tree (the release's own sources)
diff -rq --no-dereference $KR $R > $L/release-delta-v3-vs-kept.txt || true
echo "RELEASE-DELTA-VS-KEPT $(wc -l < $L/release-delta-v3-vs-kept.txt) lines"
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
python3 - $KI/initramfs.cpio.gz $OUT/initramfs.cpio.gz $R $L/image-delta-v3-vs-kept.json $S2I/initramfs.cpio.gz $L/image-delta-v3-vs-stage2.json <<'PY'
import gzip,hashlib,importlib.util,sys,json,os
spec=importlib.util.spec_from_file_location('o',sys.argv[3]+'/metal/overlay-control-image.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
def index(p):
    r={}
    with gzip.open(p,'rb') as f:
        for key,name,fields,header in o.entries(f):
            d=o.exact(f,fields[6]);o.exact(f,-fields[6]%4)
            r[key]=(hashlib.sha256(d).hexdigest(),tuple(fields[1:6]))
    return r
b=index(sys.argv[2])
for ref,outp,label in [(sys.argv[1],sys.argv[4],'KEPT'),(sys.argv[5],sys.argv[6],'STAGE2')]:
    a=index(ref)
    changed=sorted(k for k in set(a)&set(b) if a[k]!=b[k]); added=sorted(set(b)-set(a)); removed=sorted(set(a)-set(b))
    json.dump({'changed':changed,'added':added,'removed':removed,'entries':[len(a),len(b)]},open(outp,'w'),indent=1)
    print('IMAGE-VS-'+label,'ENTRIES',len(a),len(b),'CHANGED',len(changed),'ADDED',len(added),'REMOVED',len(removed))
    for k in changed+added: print('  ',('changed' if k in a else 'added'),k)
    for k in removed: print('   removed',k)
    bad=[k for k in changed+added+removed if not (k.startswith('app/') or k.startswith('opt/metal/'))]
    if bad: sys.exit('IMAGE-DELTA-OUTSIDE-APP-AND-OPT-METAL '+repr(bad))
    src=lambda k: sys.argv[3]+'/'+k[4:] if k.startswith('app/') else sys.argv[3]+'/metal/guest/'+k[len('opt/metal/'):]
    mism=[k for k in changed+added if k!='opt/metal/manifest.json' and os.path.isfile(src(k)) and hashlib.sha256(open(src(k),'rb').read()).hexdigest()!=b[k][0]]
    if mism: sys.exit('IMAGE-FILE-NOT-SOURCE '+repr(mism))
    print('IMAGE-VS-'+label+' DELTA-WITHIN-APP-AND-OPT-METAL; every changed/added regular file is the release source bytes')
PY
python3 - $OUT/manifest.json $S/extract $R $COMMIT <<'PY'
import json,hashlib,sys,os
m=json.load(open(sys.argv[1])); x,r,c=sys.argv[2:5]; co=m['controlOverlay']
h=lambda p: hashlib.sha256(open(p,'rb').read()).hexdigest()
assert co['commit']==c and m['initramfs']['sha256']==h(os.path.join(os.path.dirname(sys.argv[1]),'initramfs.cpio.gz'))
for f in co['files']: assert h(x+f['path'])==f['sha256']==h(r+'/'+f['source']),(f['path'],f['source'])
print('EVERY-OVERLAID-FILE == MANIFEST == RELEASE-SOURCE-BYTES',len(co['files']),'files;',sum(f['path'].startswith('/opt/metal/') for f in co['files']),'under /opt/metal; builder',co['builderSha256'])
PY
for f in owner-nomination.mjs lease-gas-conduit.bundle.mjs measured-control.mjs gsup.mjs host-policy.bundle.mjs; do cmp -s $S/extract/opt/metal/$f $R/metal/guest/$f && echo "OPT-METAL-IS-SOURCE $f" || { echo "OPT-METAL-DIFFERS $f"; exit 1; }; done
for f in supervisor.js metal/guest/owner-nomination.mjs network/host-owner-nomination.mjs client/lease-executor-client.mjs network/lease-gas-runtime.mjs relay/net-guard.mjs windows/node/host-admission.bundle.mjs; do cmp -s $S/extract/app/$f $R/$f && echo "APP-IS-SOURCE $f" || { echo "APP-DIFFERS $f"; exit 1; }; done
grep -c 'https://134.199.235.187/platform-policy' $S/extract/opt/metal/host-policy.bundle.mjs $S/extract/app/windows/node/host-admission.bundle.mjs | sed 's/^/POLICY-MIRRORS-IN-IMAGE-BUNDLE /'
node $S/launcher-check.mjs $R $S/extract
node --input-type=module -e 'import fs from "node:fs"; const { checkOwnerNomination } = await import(process.argv[1]); const n = checkOwnerNomination(JSON.parse(fs.readFileSync(process.argv[2], "utf8"))); console.log("OWNER-CONFIG-OK-BY-IMAGE-CHECKER", n.ownershipContract, n.owner);' "$S/extract/app/metal/guest/owner-nomination.mjs" "$L/metal0-owner-nomination.json"
node --input-type=module -e 'import fs from "node:fs"; const { checkOwnerNomination } = await import(process.argv[1]); try { checkOwnerNomination({ ...JSON.parse(fs.readFileSync(process.argv[2], "utf8")), endpoint: "http://api.enclave.host/t/metal0" }); console.log("UNEXPECTED-ACCEPT"); process.exit(1); } catch (e) { console.log("OWNER-CONFIG-TAMPER-REFUSED", String(e.message).slice(0, 120)); }' "$S/extract/app/metal/guest/owner-nomination.mjs" "$L/metal0-owner-nomination.json"
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files)"
echo STAGE-COMBINED-V3-OK
