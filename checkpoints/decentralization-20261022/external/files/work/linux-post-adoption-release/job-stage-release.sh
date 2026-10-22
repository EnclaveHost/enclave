#!/bin/sh
# POST-ADOPTION Linux release (immutable; v1; adapted from the reviewed linux-corrected-release/job-stage-release.sh with
# its r2 manifest fix). No production mutation. Input: the FROZEN linux-corrected-release/tree (== commit 51516b778) plus
# ONLY linux-post-adoption-repair/post-adoption-repair.v2.patch (39ffbbc9...), copied to ./tree with no node_modules.
#  1. a NEW scratch commit, child of 51516b778 in a CLONE of linux-corrected-release/stage/scratch.git; delta asserted
#     exactly: M supervisor.js, M client/lease-executor-client.mjs, A the two regression tests; both sources are the
#     tested v2 bytes;
#  2. the real builder (tree/metal/overlay-control-image.py) overlays it onto the read-only production image
#     dist-sdshield-2857356cd; the image's modules import from the image (import-check);
#  3. the production measurement recipe first reproduces the CURRENT image's recorded MEASUREMENT, then measures the new;
#  4. image vs 51516b778's staged image, entry by entry: only app/supervisor.js, app/client/lease-executor-client.mjs and
#     opt/metal/manifest.json differ, and the two app files are the source bytes; the dist manifest differs only in the
#     overlay commit, those two files' records and its own generated initramfs record;
#  5. the launcher release dir (git archive, no node_modules) vs 51516b778's staged release: exactly the 4 files; then
#     launcher-check (fake QEMU, fw_cfg -> the image's conduit bundle -> its loader).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/linux-post-adoption-release; T=$L/tree; S=$L/stage
OLD=$W/linux-corrected-release/stage
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
SUP=01ac9cb17a5a5af6df8992121c75239a580845748ae89f3843e080a617a5f951
[ ! -e "$S/scratch.git" ] || { echo "staging already attempted; inspect before retry"; exit 2; }
[ ! -e "$T/node_modules" ] || { echo "the release tree must carry no node_modules"; exit 2; }
[ "$(cat $OLD/dist-leasegas-51516b778/MEASUREMENT)" = 9fcbd925ada7a67a7b175e933f83f10681be06d86fc4b6ad46000809f9e82628e28fee5a50e1a591e23082b25f0ca0b4 ] || { echo "51516b778 image changed"; exit 2; }
[ "$(sha256sum < $OLD/dist-leasegas-51516b778/initramfs.cpio.gz | cut -c1-64)" = 3b8d71c55920386dbbeb15ed4a86251468732b55a86d356c7e7e030b615f9c2e ] || { echo "51516b778 initramfs changed"; exit 2; }
git clone -q --bare --no-hardlinks "$OLD/scratch.git" "$S/scratch.git"
export GIT_DIR=$S/scratch.git GIT_WORK_TREE=$T
PARENT=$(git rev-parse HEAD)
[ "$PARENT" = 51516b77884bb87d948969568d2eca58ae1a7fba ] || { echo "unexpected parent $PARENT"; exit 2; }
git read-tree "$PARENT"
git -c core.autocrlf=false add -A -- .
git -c user.name=stage -c user.email=stage@localhost commit -q -m "linux post-adoption release: own-lease vouch/reaper + refusal-aware silence + settled authorization nonce (SCRATCH commit, not main)"
COMMIT=$(git rev-parse HEAD); SHORT=$(echo $COMMIT | cut -c1-9); echo "SCRATCH-COMMIT $COMMIT parent $PARENT"
git diff --name-status "$PARENT" "$COMMIT" > $L/commit-delta.txt; cat $L/commit-delta.txt
printf 'M\tclient/lease-executor-client.mjs\nM\tsupervisor.js\nA\ttest/isolation-post-adoption-lease.test.mjs\nA\ttest/lease-authorization-nonce.test.mjs\n' | sort > $L/commit-delta.expected
sort $L/commit-delta.txt | cmp -s - $L/commit-delta.expected && echo COMMIT-DELTA-EXACT || { echo "COMMIT-DELTA-UNEXPECTED"; exit 1; }
[ "$(git show $COMMIT:supervisor.js | sha256sum | cut -c1-64)" = $SUP ] \
  && [ "$(git show $COMMIT:client/lease-executor-client.mjs | sha256sum | cut -c1-64)" = "$(sha256sum < $W/linux-post-adoption-repair/tree/client/lease-executor-client.mjs | cut -c1-64)" ] \
  && echo COMMIT-SOURCES-ARE-TESTED-V2-BYTES || { echo COMMIT-SOURCES-NOT-TESTED; exit 1; }
OUT=$S/dist-leasegas-$SHORT
python3 $T/metal/overlay-control-image.py $BASE $OUT $COMMIT
echo OVERLAY-STAGED $OUT
python3 $S/extract.py $OUT/initramfs.cpio.gz $S/extract
node $S/import-check.mjs $S/extract
for f in supervisor.js client/lease-executor-client.mjs network/lease-executor-client.mjs; do
  cmp -s $S/extract/app/$f $T/$f && echo "IMAGE-FILE-IS-SOURCE app/$f $(sha256sum < $T/$f | cut -c1-64)" || { echo "IMAGE-FILE-DIFFERS app/$f"; exit 1; }
done
CUR=$($MEASURE "$APPEND" --kernel $BASE/vmlinuz --initrd $BASE/initramfs.cpio.gz --output-format hex)
echo "MEASURE-CURRENT $CUR recorded $(cat $BASE/MEASUREMENT)"
[ "$CUR" = "$(cat $BASE/MEASUREMENT)" ] && echo MEASURE-RECIPE-REPRODUCES-PRODUCTION || { echo MEASURE-RECIPE-MISMATCH; exit 1; }
PREV=$($MEASURE "$APPEND" --kernel $OLD/dist-leasegas-51516b778/vmlinuz --initrd $OLD/dist-leasegas-51516b778/initramfs.cpio.gz --output-format hex)
[ "$PREV" = "$(cat $OLD/dist-leasegas-51516b778/MEASUREMENT)" ] && echo MEASURE-RECIPE-REPRODUCES-51516b778 || { echo MEASURE-51516b778-MISMATCH; exit 1; }
NEW=$($MEASURE "$APPEND" --kernel $OUT/vmlinuz --initrd $OUT/initramfs.cpio.gz --output-format hex)
echo "$NEW" > $OUT/MEASUREMENT
echo "MEASURE-STAGED $NEW"
sha256sum $OUT/initramfs.cpio.gz $OUT/vmlinuz $OUT/cmdline $OUT/manifest.json $OUT/MEASUREMENT
cmp -s $OUT/vmlinuz $OLD/dist-leasegas-51516b778/vmlinuz && cmp -s $OUT/cmdline $OLD/dist-leasegas-51516b778/cmdline && cmp -s $OUT/vmlinuz $BASE/vmlinuz && echo "KERNEL-CMDLINE-SAME-AS-51516b778-AND-PRODUCTION" || { echo KERNEL-OR-CMDLINE-DIFFERS; exit 1; }
python3 - $OLD/dist-leasegas-51516b778/initramfs.cpio.gz $OUT/initramfs.cpio.gz $T <<'PY'
import gzip,hashlib,importlib.util,sys
spec=importlib.util.spec_from_file_location('o',sys.argv[3]+'/metal/overlay-control-image.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
def index(p):
    r={}
    with gzip.open(p,'rb') as f:
        for key,name,fields,header in o.entries(f):
            d=o.exact(f,fields[6]);o.exact(f,-fields[6]%4)
            r[key]=(hashlib.sha256(d).hexdigest(),tuple(fields[1:6]))
    return r
a,b=index(sys.argv[1]),index(sys.argv[2])
diff=sorted(k for k in set(a)|set(b) if a.get(k)!=b.get(k))
print('IMAGE-ENTRIES', len(a), len(b), 'DIFFER', diff)
if diff!=['app/client/lease-executor-client.mjs','app/supervisor.js','opt/metal/manifest.json']: sys.exit('IMAGE-DELTA-UNEXPECTED')
print('IMAGE-DELTA-EXACT')
PY
python3 - $OLD/dist-leasegas-51516b778/manifest.json $OUT/manifest.json $OUT/initramfs.cpio.gz $T <<'PY'
import json,sys,hashlib,os
a,b=(json.load(open(p)) for p in sys.argv[1:3])
ia,ib=a.pop('initramfs'),b.pop('initramfs')
assert ib['sha256']==hashlib.sha256(open(sys.argv[3],'rb').read()).hexdigest() and ib['bytes']==os.path.getsize(sys.argv[3]),'initramfs record is not the staged file'
ca,cb=a.pop('controlOverlay'),b.pop('controlOverlay')
assert a==b,'manifest outside controlOverlay/initramfs differs'
fa={x['path']:x for x in ca.pop('files')}; fb={x['path']:x for x in cb.pop('files')}
assert ca.pop('commit')!=cb.pop('commit')
assert ca==cb,'controlOverlay fields differ beyond commit/files'
d=[p for p in sorted(set(fa)|set(fb)) if fa.get(p)!=fb.get(p)]
assert d==['/app/client/lease-executor-client.mjs','/app/supervisor.js'],d
for p in d: assert fb[p]['sha256']==hashlib.sha256(open(sys.argv[4]+p[4:],'rb').read()).hexdigest(),p
print('MANIFEST-DELTA-EXACT commit +', ' + '.join(f"{p} {fb[p]['sha256']}" for p in d), '+ its own initramfs record', ib['sha256'])
PY
R=$S/metal-$SHORT
[ ! -e $R ] || { echo "release dir exists; inspect"; exit 2; }
mkdir -p $R
git archive $COMMIT | tar -x -C $R
[ ! -e $R/node_modules ] && echo "RELEASE-NO-NODE_MODULES" || { echo RELEASE-HAS-NODE_MODULES; exit 1; }
diff -rq --no-dereference $OLD/metal-51516b778 $R > $L/release-delta.txt || true
cat $L/release-delta.txt
printf '%s\n' "Files $OLD/metal-51516b778/client/lease-executor-client.mjs and $R/client/lease-executor-client.mjs differ" "Files $OLD/metal-51516b778/supervisor.js and $R/supervisor.js differ" "Only in $R/test: isolation-post-adoption-lease.test.mjs" "Only in $R/test: lease-authorization-nonce.test.mjs" | sort > $L/release-delta.expected
sort $L/release-delta.txt | cmp -s - $L/release-delta.expected && echo RELEASE-DELTA-EXACT || { echo RELEASE-DELTA-UNEXPECTED; exit 1; }
diff -rq --no-dereference /home/steven/enclave-prod/metal-51516b778 $OLD/metal-51516b778 >/dev/null && echo "STAGED-PROD-51516b778-RELEASE == LOCAL-51516b778-RELEASE" || { echo "production-staged 51516b778 release differs from the local one"; exit 1; }
node $S/launcher-check.mjs $R $S/extract
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files)"
echo STAGE-RELEASE-OK
