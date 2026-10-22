#!/bin/sh
# Stage (no production mutation): the candidate committed to a SCRATCH repository (not main), overlaid by the real
# builder (metal/overlay-control-image.py) onto the CURRENT production control image (read only; the builder never
# modifies its base), the staged image's modules imported from the image itself, and both launch measurements computed
# with the production launch parameters (OVMF fwbuild, 4 vCPUs, this host's CPU signature, the production cmdline) - the
# current image's first, to prove the recipe against its recorded MEASUREMENT.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/linux-lease-activation; T=$L/tree; S=$L/stage
BASE=/home/steven/enclave-prod/dist-sdshield-2857356cd
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
rm -rf $S/scratch.git $S/extract $S/dist-leasegas-*
export GIT_DIR=$S/scratch.git GIT_WORK_TREE=$T
git init -q
git -c core.autocrlf=false add -A .
git -c user.name=stage -c user.email=stage@localhost commit -q -m "linux-lease-activation candidate (SCRATCH commit, not main)"
COMMIT=$(git rev-parse HEAD); echo "SCRATCH-COMMIT $COMMIT"
# what the production base image carries of the candidate supervisor's closure
python3 - "$BASE/initramfs.cpio.gz" "$T" <<'PY'
import gzip,hashlib,importlib.util,json,sys,subprocess
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
for st in ('ABSENT','DIFFERS','SAME'):
    sel=[x for x in files if (x not in have and st=='ABSENT') or (x in have and st=='DIFFERS' and have[x]!=hashlib.sha256(open(sys.argv[2]+'/'+x,'rb').read()).hexdigest()) or (x in have and st=='SAME' and have[x]==hashlib.sha256(open(sys.argv[2]+'/'+x,'rb').read()).hexdigest())]
    print('BASE-'+st,len(sel),' '.join(sel))
PY
OUT=$S/dist-leasegas-$(echo $COMMIT | cut -c1-9)
python3 $T/metal/overlay-control-image.py $BASE $OUT $COMMIT
echo OVERLAY-STAGED $OUT
python3 $S/extract.py $OUT/initramfs.cpio.gz $S/extract
node $S/import-check.mjs $S/extract
CUR=$($MEASURE "$APPEND" --kernel $BASE/vmlinuz --initrd $BASE/initramfs.cpio.gz --output-format hex)
echo "MEASURE-CURRENT $CUR recorded $(cat $BASE/MEASUREMENT)"
[ "$CUR" = "$(cat $BASE/MEASUREMENT)" ] && echo MEASURE-RECIPE-REPRODUCES-PRODUCTION
NEW=$($MEASURE "$APPEND" --kernel $OUT/vmlinuz --initrd $OUT/initramfs.cpio.gz --output-format hex)
echo "$NEW" > $OUT/MEASUREMENT
echo "MEASURE-STAGED $NEW"
sha256sum $OUT/initramfs.cpio.gz $OUT/vmlinuz $OUT/cmdline $OUT/manifest.json
rm -rf $S/extract
echo STAGE-OK
