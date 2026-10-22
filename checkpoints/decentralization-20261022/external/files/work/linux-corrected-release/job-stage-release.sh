#!/bin/sh
# CORRECTED narrow Linux release (immutable; adapted from linux-lease-root-release/job-stage.sh + job-release.sh).
# No production mutation. Input: the FROZEN linux-lease-root-release/tree plus ONLY linux-resume-repair/resume-repair.patch
# (sha256 ba64ca7b...), copied to ./tree with no node_modules at all. Steps:
#  1. a NEW scratch commit, child of root's c083e27a8 in a CLONE of root's scratch repo; asserted to differ from c083 by
#     exactly: supervisor.js (production Shield parity), test/isolation-resume-shield-model.test.mjs (the regression
#     test), and the removal of the development-only node_modules symlink c083 tracked by accident;
#  2. the real builder (metal/overlay-control-image.py) overlays it onto the read-only production image
#     dist-sdshield-2857356cd; the image's own modules are imported from the image (import-check);
#  3. the production measurement recipe reproduces the CURRENT image's recorded MEASUREMENT first, then measures the new;
#  4. the image is compared entry by entry with c083's staged image: only app/supervisor.js and opt/metal/manifest.json
#     may differ;
#  5. the launcher release dir (git archive of the new commit, no node_modules) is compared with root's staged
#     metal-c083e27a8 and driven by launcher-check (fake QEMU, fw_cfg -> the image's conduit bundle -> its loader).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/linux-corrected-release; T=$L/tree; S=$L/stage
OLD=$W/linux-lease-root-release/stage
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
[ ! -e "$S/scratch.git" ] || { echo "staging already attempted; inspect before retry"; exit 2; }
[ ! -e "$T/node_modules" ] || { echo "the corrected tree must carry no node_modules"; exit 2; }
git clone -q --bare --no-hardlinks "$OLD/scratch.git" "$S/scratch.git"
export GIT_DIR=$S/scratch.git GIT_WORK_TREE=$T
PARENT=$(git rev-parse HEAD)
[ "$PARENT" = c083e27a868e284f27754a5abe190d7c4a676ff3 ] || { echo "unexpected parent $PARENT"; exit 2; }
git read-tree "$PARENT"
git -c core.autocrlf=false add -A -- . ':!node_modules'
git rm -q --cached node_modules
git -c user.name=stage -c user.email=stage@localhost commit -q -m "linux corrected release: production Shield model parity + resume regression test (SCRATCH commit, not main)"
COMMIT=$(git rev-parse HEAD); SHORT=$(echo $COMMIT | cut -c1-9); echo "SCRATCH-COMMIT $COMMIT parent $PARENT"
git diff --name-status "$PARENT" "$COMMIT" > $L/commit-delta.txt; cat $L/commit-delta.txt
printf 'D\tnode_modules\nM\tsupervisor.js\nA\ttest/isolation-resume-shield-model.test.mjs\n' | sort > $L/commit-delta.expected
sort $L/commit-delta.txt | cmp -s - $L/commit-delta.expected && echo COMMIT-DELTA-EXACT || { echo "COMMIT-DELTA-UNEXPECTED"; exit 1; }
[ "$(git show $COMMIT:supervisor.js | sha256sum | cut -c1-64)" = babe0c7d1ba83cbb4fe9a990dbaefb74d3e643c0fd05d16db82df2eb85cc69e3 ] && echo COMMIT-SUPERVISOR-IS-TESTED-BYTES || { echo COMMIT-SUPERVISOR-NOT-TESTED-BYTES; exit 1; }
# what the production base image carries of the corrected supervisor's closure (as root's stage reports it)
python3 - "$BASE/initramfs.cpio.gz" "$T" <<'PY'
import gzip,hashlib,importlib.util,sys
spec=importlib.util.spec_from_file_location('o',sys.argv[2]+'/metal/overlay-control-image.py');o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
def read(r):
    try: return open(sys.argv[2]+'/'+r,encoding='utf8').read()
    except OSError: return None
files,packages=o.supervisor_closure(read,o.SUPERVISOR_ROOTS+o.APP_FILES)
have={}
with gzip.open(sys.argv[1],'rb') as f:
    for key,name,fields,header in o.entries(f):
        d=o.exact(f,fields[6]);o.exact(f,-fields[6]%4)
        if key.startswith('app/'): have[key[4:]]=hashlib.sha256(d).hexdigest()
h=lambda x: hashlib.sha256(open(sys.argv[2]+'/'+x,'rb').read()).hexdigest()
for st in ('ABSENT','DIFFERS','SAME'):
    sel=[x for x in files if (x not in have and st=='ABSENT') or (x in have and st=='DIFFERS' and have[x]!=h(x)) or (x in have and st=='SAME' and have[x]==h(x))]
    print('BASE-'+st,len(sel),' '.join(sel))
print('BASE-SUPERVISOR-SAME-AS-PRODUCTION', have.get('supervisor.js')==h('supervisor.js'))
PY
OUT=$S/dist-leasegas-$SHORT
python3 $T/metal/overlay-control-image.py $BASE $OUT $COMMIT
echo OVERLAY-STAGED $OUT
python3 $S/extract.py $OUT/initramfs.cpio.gz $S/extract
node $S/import-check.mjs $S/extract
CUR=$($MEASURE "$APPEND" --kernel $BASE/vmlinuz --initrd $BASE/initramfs.cpio.gz --output-format hex)
echo "MEASURE-CURRENT $CUR recorded $(cat $BASE/MEASUREMENT)"
[ "$CUR" = "$(cat $BASE/MEASUREMENT)" ] && echo MEASURE-RECIPE-REPRODUCES-PRODUCTION || { echo MEASURE-RECIPE-MISMATCH; exit 1; }
NEW=$($MEASURE "$APPEND" --kernel $OUT/vmlinuz --initrd $OUT/initramfs.cpio.gz --output-format hex)
echo "$NEW" > $OUT/MEASUREMENT
echo "MEASURE-STAGED $NEW"
sha256sum $OUT/initramfs.cpio.gz $OUT/vmlinuz $OUT/cmdline $OUT/manifest.json $OUT/MEASUREMENT
cmp -s $OUT/vmlinuz $OLD/dist-leasegas-c083e27a8/vmlinuz && cmp -s $OUT/cmdline $OLD/dist-leasegas-c083e27a8/cmdline && echo "KERNEL-CMDLINE-SAME-AS-C083" || { echo KERNEL-OR-CMDLINE-DIFFERS; exit 1; }
# image vs c083's staged image, entry by entry (content + cpio metadata)
python3 - $OLD/dist-leasegas-c083e27a8/initramfs.cpio.gz $OUT/initramfs.cpio.gz $T <<'PY'
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
if diff!=['app/supervisor.js','opt/metal/manifest.json']: sys.exit('IMAGE-DELTA-UNEXPECTED')
print('IMAGE-DELTA-EXACT')
PY
# the manifest: only the overlay commit and the supervisor's recorded hash may differ from c083's
python3 - $OLD/dist-leasegas-c083e27a8/manifest.json $OUT/manifest.json <<'PY'
import json,sys
a,b=(json.load(open(p)) for p in sys.argv[1:3])
ca,cb=a.pop('controlOverlay'),b.pop('controlOverlay')
assert a==b,'manifest outside controlOverlay differs'
fa={x['path']:x for x in ca.pop('files')}; fb={x['path']:x for x in cb.pop('files')}
assert ca.pop('commit')!=cb.pop('commit')
assert ca==cb,'controlOverlay fields differ beyond commit/files'
d=[p for p in sorted(set(fa)|set(fb)) if fa.get(p)!=fb.get(p)]
assert d==['/app/supervisor.js'],d
print('MANIFEST-DELTA-EXACT commit + /app/supervisor.js', fb['/app/supervisor.js']['sha256'])
PY
# 5. the launcher release dir
R=$S/metal-$SHORT
mkdir -p $R
git archive $COMMIT | tar -x -C $R
[ ! -e $R/node_modules ] && echo "RELEASE-NO-NODE_MODULES" || { echo RELEASE-HAS-NODE_MODULES; exit 1; }
diff -rq --no-dereference $OLD/metal-c083e27a8 $R > $L/release-delta.txt || true
cat $L/release-delta.txt
printf '%s\n' "Files $OLD/metal-c083e27a8/supervisor.js and $R/supervisor.js differ" "Only in $R/test: isolation-resume-shield-model.test.mjs" | sort > $L/release-delta.expected
sort $L/release-delta.txt | cmp -s - $L/release-delta.expected && echo RELEASE-DELTA-EXACT || { echo RELEASE-DELTA-UNEXPECTED; exit 1; }
node $S/launcher-check.mjs $R $S/extract
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files)"
echo STAGE-RELEASE-OK
