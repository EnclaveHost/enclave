#!/bin/bash
# Bounded, reproducible control-overlay build (no VM, no production change). Reviewed recipe of
# linux-post-adoption-release/job-stage-release.sh steps 2-4, adapted: base = the read-only production base image,
# control = deabf8f90 rebuilt from this repo (must equal production byte for byte), candidate = the restore commit.
set -euo pipefail
cd "$(dirname "$0")"
R=$PWD/repo; S=$PWD/stage; P=/home/steven/enclave-prod
BASE=$P/dist-sdshield-2857356cd; PROD=$P/dist-leasegas-deabf8f90
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
OLD=deabf8f90f64902d20d48620fd911d34c445859d
NEW=$(git -C $R rev-parse HEAD); SHORT=${NEW:0:9}
[ ! -e $S ] || { echo "stage exists: inspect before retry"; exit 2; }
[ -z "$(git -C $R status --porcelain --untracked-files=no)" ] || { echo "repo not clean"; exit 2; }
[ "$(git -C $R rev-parse HEAD~1)" = $OLD ] || { echo "HEAD~1 is not deabf8f90"; exit 2; }
[ "$(git -C $R diff --name-only $OLD HEAD -- metal/ supervisor.js | tr '\n' ' ')" = "metal/guest/gsup.mjs " ] || { echo "image-relevant delta is not exactly gsup.mjs"; exit 2; }
[ "$(sha256sum < $BASE/initramfs.cpio.gz | cut -c1-64)" = 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc ] || { echo "base initramfs changed"; exit 2; }
[ "$(sha256sum < $PROD/initramfs.cpio.gz | cut -c1-64)" = c190c040485974a840b40e31a6dd068cc103199cf15315ef9c8c7575781b28e3 ] || { echo "production initramfs changed"; exit 2; }
[ "$(sha256sum < $PROD/manifest.json | cut -c1-64)" = c7cb436db609f361a07d5f32a8a0d71f4fc399f329d244ff2512da8ca34dfca4 ] || { echo "production manifest changed"; exit 2; }
mkdir -p $S
date -u +%FT%TZ
echo "== 1. control: deabf8f90 rebuilt from this repo"
(cd $R && python3 metal/overlay-control-image.py $BASE $S/control-deabf8f90 $OLD)
for f in initramfs.cpio.gz vmlinuz cmdline manifest.json; do
  cmp -s $S/control-deabf8f90/$f $PROD/$f && echo "CONTROL-IDENTICAL $f" || { echo "CONTROL-DIFFERS $f"; exit 1; }
done
echo "== 2. candidate: $NEW"
(cd $R && python3 metal/overlay-control-image.py $BASE $S/dist-leasegas-$SHORT $NEW)
OUT=$S/dist-leasegas-$SHORT
echo "== 3. entry-by-entry vs production"
python3 -I entries.py $PROD/initramfs.cpio.gz $OUT/initramfs.cpio.gz | tee $S/entries-vs-production.jsonl | tail -1
python3 -I - $S/entries-vs-production.jsonl <<'PY'
import json, sys
last = json.loads(open(sys.argv[1]).read().splitlines()[-1])
assert last['differing'] == ['opt/metal/gsup.mjs', 'opt/metal/manifest.json'], last['differing']
print('ENTRY-DELTA-EXACT: only opt/metal/gsup.mjs and opt/metal/manifest.json differ')
PY
git -C $R show $NEW:metal/guest/gsup.mjs | cmp -s - <(python3 -I - $OUT/initramfs.cpio.gz <<'PY'
import gzip, sys
with gzip.open(sys.argv[1], 'rb') as f:
    buf = bytearray()
    def read(n):
        while len(buf) < n:
            c = f.read(65536)
            if not c: raise EOFError
            buf.extend(c)
        d = bytes(buf[:n]); del buf[:n]; return d
    while True:
        h = read(110); fld = [int(h[6+8*i:14+8*i], 16) for i in range(13)]
        name = read(fld[11])[:-1].decode(); read((-(110+fld[11])) % 4)
        data = read(fld[6]); read((-fld[6]) % 4)
        if name == 'opt/metal/gsup.mjs': sys.stdout.buffer.write(data); break
        if name == 'TRAILER!!!': raise SystemExit('no gsup')
PY
) && echo "IMAGE-GSUP-IS-SOURCE" || { echo "IMAGE-GSUP-DIFFERS"; exit 1; }
python3 -I - $PROD/manifest.json $OUT/manifest.json $NEW <<'PY'
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
assert {k for k in a if a[k] != b[k]} == {'controlOverlay', 'initramfs'}, {k for k in a if a[k] != b[k]}
ca, cb = a['controlOverlay'], b['controlOverlay']
assert {k for k in ca if ca[k] != cb[k]} == {'commit', 'files'} and cb['commit'] == sys.argv[3]
fa, fb = {f['path']: f for f in ca['files']}, {f['path']: f for f in cb['files']}
assert set(fa) == set(fb) and [p for p in fa if fa[p] != fb[p]] == ['/opt/metal/gsup.mjs']
print('MANIFEST-DELTA-EXACT: controlOverlay.commit, the gsup record and the initramfs record')
PY
echo "== 4. measurement"
CUR=$($MEASURE "$APPEND" --kernel $PROD/vmlinuz --initrd $PROD/initramfs.cpio.gz --output-format hex)
[ "$CUR" = "$(cat $PROD/MEASUREMENT)" ] && echo "MEASURE-RECIPE-REPRODUCES-PRODUCTION $CUR" || { echo "MEASURE-RECIPE-MISMATCH $CUR"; exit 1; }
M=$($MEASURE "$APPEND" --kernel $OUT/vmlinuz --initrd $OUT/initramfs.cpio.gz --output-format hex)
echo "$M" > $OUT/MEASUREMENT
echo "MEASURE-CANDIDATE $M"
sha256sum $OUT/initramfs.cpio.gz $OUT/vmlinuz $OUT/cmdline $OUT/manifest.json $OUT/MEASUREMENT
date -u +%FT%TZ
