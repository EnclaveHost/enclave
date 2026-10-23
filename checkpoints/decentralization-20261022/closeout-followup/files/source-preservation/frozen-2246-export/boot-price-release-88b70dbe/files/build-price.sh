#!/bin/bash
# BOUNDED BUILD of ROOT's approved boot-price fix (a single-parent child of 9f6d37bd in work/custody-boot-registration-20261023/repo).
# Prepared 2026-10-23, NOT run by its author; root runs it only after writing APPROVED-COMMIT.txt here (format: precheck.py).
# No VM, no production change, no admission change. Refuses on any deviation:
#   0. precheck.py: approval format; parent exactly 9f6d37bd; delta exactly supervisor.js + the approved tests (+ gsup.mjs only if
#      root wrote "gsup REVIEWED"); builder unchanged; source patch (parent-anchored, never the whole tree) free of the rewritten
#      provider literal -> stage/<short>-on-9f6d37bd.patch. Then: the base, production, a6 and root-built 08d1 images unchanged.
#   1. CONTROL: 9f6d37bd rebuilt from H's repo == the root-built 08d1f838 image byte for byte (restore stage-approved, = the
#      ~/enclave-prod copy when present).
#   2. the candidate built TWICE, byte-identical.
#   3. verify.py: exact manifest/entry delta vs 08d1 and production; the image's changed files and gsup.mjs = the commit's bytes.
#   4. the measurement recipe reproduces ed918e4b (production), ee5df6b8 (a6) and 08d1f838 (9f) first, then measures the candidate,
#      which must be none of them.
# Run (after approval): ./q.sh 1024 build-price-1 bash ./build-price.sh     (the 9f build peaked at 301 MiB)
set -euo pipefail
cd "$(dirname "$0")"
H=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-boot-registration-20261023/repo
RST=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-recipient-restore-20261023
S=$PWD/stage; P=/home/steven/enclave-prod
BASE=$P/dist-sdshield-2857356cd; PROD=$P/dist-leasegas-deabf8f90; A6=$RST/stage/dist-leasegas-a6b1378cd
N9=$RST/stage-approved/dist-leasegas-9f6d37bd8; N9P=$P/dist-leasegas-9f6d37bd8
PARENT=9f6d37bd858ad44be1171b6415353910214c2fa5
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
export GIT_OPTIONAL_LOCKS=0
[ -f APPROVED-COMMIT.txt ] || { echo "REFUSED: no APPROVED-COMMIT.txt from root"; exit 2; }
[ ! -e $S ] || { echo "stage exists: inspect before retry"; exit 2; }
mkdir -p $S.precheck; trap 'rm -rf $S.precheck' EXIT
PC=$(python3 -I precheck.py $H APPROVED-COMMIT.txt $S.precheck/patch) || { echo "$PC"; exit 2; }
echo "$PC"
NEW=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1].split(" ",1)[1])["commit"])' "$PC")
FILES=$(python3 -I -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1].split(" ",1)[1])["imageFiles"]))' "$PC")
SHORT=${NEW:0:9}
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || { echo "REFUSED: $1 is not the pinned file"; exit 2; }; }
pin $BASE/initramfs.cpio.gz 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc
pin $PROD/initramfs.cpio.gz c190c040485974a840b40e31a6dd068cc103199cf15315ef9c8c7575781b28e3
pin $PROD/manifest.json c7cb436db609f361a07d5f32a8a0d71f4fc399f329d244ff2512da8ca34dfca4
pin $A6/initramfs.cpio.gz 5ce61b6f590ed6b84f6d463a949234562c4a6fd8646b74b3de69d6e2e442f1de
pin $A6/MEASUREMENT d99cb42849311fb017b76b35bb200ff847ea2d548b369ddffabf5e6c954660c9
for d in $N9 $N9P; do
  [ -d $d ] || { [ $d = $N9P ] && continue; echo "REFUSED: $d missing"; exit 2; }
  pin $d/initramfs.cpio.gz 02c7280a7020f29395d9e38e361d72aad8b39311218a1dd272dc2893e562dfaf
  pin $d/manifest.json 64bd025db3ed62b82f016ed25f1bd24ab300dbe7520ca81498d3ccd293e43b16
  pin $d/MEASUREMENT 6d55c0e2839e5a1aad1258ce80ec112181f155c50be9f5ad1f66f1bb44064537
  pin $d/vmlinuz 1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7
  pin $d/cmdline d9e04c2c4769a4aadeaf4591e8e825ac513bf89f2677918d7e74638d8c9c90b8
done
cmp -s $H/metal/overlay-control-image.py <(git -C $H show $PARENT:metal/overlay-control-image.py) || { echo "REFUSED: H's checked-out builder is not 9f6d37bd's"; exit 2; }
mkdir $S; mv $S.precheck/patch $S/$SHORT-on-9f6d37bd.patch; date -u +%FT%TZ
B="python3 $H/metal/overlay-control-image.py"   # reads only git objects of the given commit + the base image
echo "== 1. control: 9f6d37bd from H's repo == the root-built 08d1f838 image"
$B $BASE $S/control-9f $PARENT
for f in initramfs.cpio.gz vmlinuz cmdline manifest.json; do cmp -s $S/control-9f/$f $N9/$f && echo "CONTROL-IDENTICAL $f" || { echo "CONTROL-DIFFERS $f"; exit 1; }; done
echo "== 2. candidate twice"
$B $BASE $S/dist-leasegas-$SHORT $NEW; $B $BASE $S/repro-$SHORT $NEW
for f in initramfs.cpio.gz vmlinuz cmdline manifest.json; do cmp -s $S/repro-$SHORT/$f $S/dist-leasegas-$SHORT/$f && echo "REPRODUCIBLE $f" || { echo "NOT-REPRODUCIBLE $f"; exit 1; }; done
rm -rf $S/repro-$SHORT $S/control-9f
OUT=$S/dist-leasegas-$SHORT
echo "== 3. exact delta"
python3 -I entries.py $N9/initramfs.cpio.gz $OUT/initramfs.cpio.gz > $S/entries-vs-9f.jsonl
python3 -I entries.py $PROD/initramfs.cpio.gz $OUT/initramfs.cpio.gz > $S/entries-vs-production.jsonl
python3 -I verify.py $S $N9/manifest.json $OUT/manifest.json $OUT/initramfs.cpio.gz $H $NEW "$FILES"
for f in vmlinuz cmdline; do cmp -s $OUT/$f $N9/$f && echo "UNCHANGED $f" || { echo "CHANGED $f"; exit 1; }; done
echo "== 4. measurement"
m() { $MEASURE "$APPEND" --kernel $1/vmlinuz --initrd $1/initramfs.cpio.gz --output-format hex; }
for d in $PROD $A6 $N9; do [ "$(m $d)" = "$(cat $d/MEASUREMENT)" ] && echo "MEASURE-RECIPE-REPRODUCES $(head -c 8 $d/MEASUREMENT)" || { echo "MEASURE-MISMATCH $d"; exit 1; }; done
M=$(m $OUT)
for d in $PROD $A6 $N9; do [ "$M" != "$(cat $d/MEASUREMENT)" ] || { echo "CANDIDATE-EQUALS-AN-OLD-IMAGE $d"; exit 1; }; done
echo "$M" > $OUT/MEASUREMENT; echo "MEASURE-CANDIDATE $M"
(cd $S && find dist-leasegas-$SHORT -type f | sort | xargs sha256sum) | tee $S/INVENTORY.sha256
python3 -I - "$PC" "$M" $S <<'PY'
import hashlib, json, pathlib, sys
rec = json.loads(sys.argv[1].split(' ', 1)[1]); s = pathlib.Path(sys.argv[3])
rec.update(measurement=sys.argv[2], inventory=dict(reversed(l.split('  ', 1)) for l in (s/'INVENTORY.sha256').read_text().splitlines()),
           controlImage='08d1f838 (9f6d37bd, root-built 21:54Z)', note='source patch only; parent anchor = 9f6d37bd (prior build record: custody-recipient-restore-20261023 BUILD-APPROVED-RESULT.md)')
(s/'build-record.json').write_text(json.dumps(rec, indent=2, sort_keys=True) + '\n'); print('BUILD-RECORD', hashlib.sha256((s/'build-record.json').read_bytes()).hexdigest())
PY
date -u +%FT%TZ
