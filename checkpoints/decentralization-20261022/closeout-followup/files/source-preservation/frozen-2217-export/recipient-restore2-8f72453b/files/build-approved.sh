#!/bin/bash
# BOUNDED BUILD of a ROOT-APPROVED boot-registration fix (H: work/custody-boot-registration-20261023/repo) on top of the restore
# commit a6b1378c. Prepared 2026-10-23; NOT run until root writes APPROVED-COMMIT.txt here. No VM, no production change.
# Root writes APPROVED-COMMIT.txt (two lines): "commit <40 hex>" and "extra <space-separated repo paths or NONE>" (extra image
# files root reviewed beyond supervisor.js; NONE for the minimal fix). The script then, refusing on any deviation:
#   0. the commit exists in H's repo, descends from a6b1378c, and its delta vs a6b1378c touches only supervisor.js, the
#      approved extras, and test/ files; the builder file is unchanged (byte-equal to a6b1378c's);
#   1. CONTROL: a6b1378c rebuilt from H's repo == the staged ee5df6b8 image byte for byte (initramfs 5ce61b6f, manifest 3874066d);
#   2. the candidate built TWICE, byte-identical;
#   3. manifest vs a6: only controlOverlay.commit, the changed file records (within supervisor.js + approved extras; every extra
#      present; none removed; builder/base/supervisorClosure unchanged) and initramfs; image entries vs a6 = exactly those files +
#      manifest.json, vs PRODUCTION deabf8f90 = those + gsup.mjs; every changed file and gsup.mjs in the image = the commit's bytes;
#   4. the measurement recipe reproduces production ed918e4b and a6's ee5df6b8, then measures the candidate.
# Extras under metal/guest/ land at /opt/metal/, all others at /app/. The builder reads only git objects + the base image.
# Run (after approval): ./q.sh 1024 build-approved-1 bash ./build-approved.sh   (restore build peaked 301 MiB; <= root's 1536)
set -euo pipefail
cd "$(dirname "$0")"
H=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-boot-registration-20261023/repo
S=$PWD/stage-approved; P=/home/steven/enclave-prod
BASE=$P/dist-sdshield-2857356cd; PROD=$P/dist-leasegas-deabf8f90; A6=$PWD/stage/dist-leasegas-a6b1378cd
A6C=a6b1378cdf430217025987d90c040d0e25a9993d
OVMF=/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd
APPEND="console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app"
MEASURE="$HOME/.local/bin/sev-snp-measure --mode snp --vcpus 4 --vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1 --vmm-type QEMU --ovmf $OVMF --append"
export GIT_OPTIONAL_LOCKS=0
[ -f APPROVED-COMMIT.txt ] || { echo "REFUSED: no APPROVED-COMMIT.txt from root"; exit 2; }
NEW=$(awk '$1=="commit"{print $2}' APPROVED-COMMIT.txt); EXTRA=$(awk '$1=="extra"{$1="";print}' APPROVED-COMMIT.txt | xargs)
[[ "$NEW" =~ ^[0-9a-f]{40}$ ]] || { echo "REFUSED: APPROVED-COMMIT.txt has no 40-hex commit"; exit 2; }
[ -n "$EXTRA" ] || { echo "REFUSED: APPROVED-COMMIT.txt must state extra paths or NONE"; exit 2; }
[ "$EXTRA" = NONE ] && EXTRA=""
SHORT=${NEW:0:9}
[ ! -e $S ] || { echo "stage-approved exists: inspect before retry"; exit 2; }
[ "$(git -C $H cat-file -t $NEW 2>/dev/null)" = commit ] || { echo "REFUSED: $NEW not in H's repo"; exit 2; }
git -C $H merge-base --is-ancestor $A6C $NEW || { echo "REFUSED: $NEW does not descend from a6b1378c"; exit 2; }
DELTA=$(git -C $H diff --name-only $A6C $NEW)
for f in $DELTA; do
  case " supervisor.js $EXTRA " in *" $f "*) continue;; esac
  case "$f" in test/*) continue;; esac
  echo "REFUSED: $f changed but is not supervisor.js, an approved extra or a test"; exit 2
done
echo "$DELTA" | grep -qx supervisor.js || [ -n "$EXTRA" ] || { echo "REFUSED: the commit changes no image file"; exit 2; }
cmp -s <(git -C $H show $A6C:metal/overlay-control-image.py) <(git -C $H show $NEW:metal/overlay-control-image.py) || { echo "REFUSED: the builder changed"; exit 2; }
for f in initramfs.cpio.gz manifest.json MEASUREMENT; do
  case $f in initramfs.cpio.gz) w=5ce61b6f590ed6b84f6d463a949234562c4a6fd8646b74b3de69d6e2e442f1de;; manifest.json) w=3874066dff197d154f51f1fe791ab66e5000e81017670cb6c39cb861e79ec12b;; MEASUREMENT) w=d99cb42849311fb017b76b35bb200ff847ea2d548b369ddffabf5e6c954660c9;; esac
  [ "$(sha256sum < $A6/$f | cut -c1-64)" = $w ] || { echo "staged a6 $f changed"; exit 2; }
done
[ "$(sha256sum < $BASE/initramfs.cpio.gz | cut -c1-64)" = 516d766d9e31f07c02544d16969c34d3d28c2bca0e4032049225635433f10afc ] || { echo "base changed"; exit 2; }
[ "$(sha256sum < $PROD/initramfs.cpio.gz | cut -c1-64)" = c190c040485974a840b40e31a6dd068cc103199cf15315ef9c8c7575781b28e3 ] || { echo "production image changed"; exit 2; }
echo "APPROVED $NEW extra=[${EXTRA}] delta: $(echo $DELTA | tr '\n' ' ')"
mkdir -p $S; date -u +%FT%TZ
# the builder runs FROM H's repo at its CURRENT checkout but reads every input from the given commit's git objects
B="python3 $H/metal/overlay-control-image.py"
cmp -s $H/metal/overlay-control-image.py <(git -C $H show $A6C:metal/overlay-control-image.py) || { echo "REFUSED: H's checked-out builder is not a6's"; exit 2; }
echo "== 1. control: a6b1378c from H's repo == the staged ee5df6b8 image"
$B $BASE $S/control-a6 $A6C
for f in initramfs.cpio.gz vmlinuz cmdline manifest.json; do cmp -s $S/control-a6/$f $A6/$f && echo "CONTROL-IDENTICAL $f" || { echo "CONTROL-DIFFERS $f"; exit 1; }; done
echo "== 2. candidate twice"
$B $BASE $S/dist-leasegas-$SHORT $NEW; $B $BASE $S/repro-$SHORT $NEW
for f in initramfs.cpio.gz vmlinuz cmdline manifest.json; do cmp -s $S/repro-$SHORT/$f $S/dist-leasegas-$SHORT/$f && echo "REPRODUCIBLE $f" || { echo "NOT-REPRODUCIBLE $f"; exit 1; }; done
rm -rf $S/repro-$SHORT $S/control-a6
OUT=$S/dist-leasegas-$SHORT
echo "== 3. exact delta (manifest records, image entries, image bytes = commit source)"
python3 -I entries.py $PROD/initramfs.cpio.gz $OUT/initramfs.cpio.gz > $S/entries-vs-production.jsonl
python3 -I entries.py $A6/initramfs.cpio.gz $OUT/initramfs.cpio.gz > $S/entries-vs-a6.jsonl
python3 -I - $S $A6/manifest.json $OUT/manifest.json $OUT/initramfs.cpio.gz $H $NEW "$EXTRA" <<'PY2'
import gzip, json, subprocess, sys
s, ma, mb, img, repo, commit, extra = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3])), sys.argv[4], sys.argv[5], sys.argv[6], sys.argv[7].split()
image_path = lambda f: '/opt/metal/' + f[len('metal/guest/'):] if f.startswith('metal/guest/') else '/app/' + f
allowed = {'/app/supervisor.js'} | {image_path(f) for f in extra}
# manifest vs the staged a6 image: only the overlay commit, the changed/added file records and the initramfs record
top = {k for k in set(ma) | set(mb) if ma.get(k) != mb.get(k)}
assert top == {'controlOverlay', 'initramfs'}, top
ca, cb = ma['controlOverlay'], mb['controlOverlay']
co = {k for k in set(ca) | set(cb) if ca.get(k) != cb.get(k)}
assert co == {'commit', 'files'} and cb['commit'] == commit, co   # builder, base, supervisorClosure packages, duplicates unchanged
fa, fb = {f['path']: f for f in ca['files']}, {f['path']: f for f in cb['files']}
assert set(fa) <= set(fb), ('removed records', set(fa) - set(fb))
changed = {p for p in fb if fa.get(p) != fb[p]}
assert changed and changed <= allowed, ('changed records', sorted(changed), 'allowed', sorted(allowed))
assert {image_path(f) for f in extra} <= changed, ('approved extra not in the image', sorted({image_path(f) for f in extra} - changed))
want_a6 = sorted([p[1:] for p in changed] + ['opt/metal/manifest.json'])
want_prod = sorted(set(want_a6) | {'opt/metal/gsup.mjs'})
last = lambda n: json.loads(open(f'{s}/{n}').read().splitlines()[-1])['differing']
assert last('entries-vs-a6.jsonl') == want_a6, (last('entries-vs-a6.jsonl'), want_a6)
assert last('entries-vs-production.jsonl') == want_prod, (last('entries-vs-production.jsonl'), want_prod)
check = {p[1:]: fb[p]['source'] for p in changed | {'/opt/metal/gsup.mjs'}}
got = {}
with gzip.open(img, 'rb') as f:
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
        if name in check: got[name] = data
        if name == 'TRAILER!!!': break
for k, src in check.items():
    assert got.get(k) == subprocess.check_output(['git', '-C', repo, 'show', f'{commit}:{src}']), k
print('MANIFEST-DELTA-EXACT', sorted(changed))
print('ENTRY-DELTA-EXACT vs a6', want_a6, 'vs production', want_prod)
print('IMAGE-FILES-ARE-SOURCE', sorted(check))
PY2
echo "== 4. measurement"
CUR=$($MEASURE "$APPEND" --kernel $PROD/vmlinuz --initrd $PROD/initramfs.cpio.gz --output-format hex)
[ "$CUR" = "$(cat $PROD/MEASUREMENT)" ] && echo "MEASURE-RECIPE-REPRODUCES-PRODUCTION" || { echo "MEASURE-MISMATCH production"; exit 1; }
A6M=$($MEASURE "$APPEND" --kernel $A6/vmlinuz --initrd $A6/initramfs.cpio.gz --output-format hex)
[ "$A6M" = "$(cat $A6/MEASUREMENT)" ] && echo "MEASURE-RECIPE-REPRODUCES-A6" || { echo "MEASURE-MISMATCH a6"; exit 1; }
M=$($MEASURE "$APPEND" --kernel $OUT/vmlinuz --initrd $OUT/initramfs.cpio.gz --output-format hex); echo "$M" > $OUT/MEASUREMENT
echo "MEASURE-CANDIDATE $M"
(cd $S && find dist-leasegas-$SHORT -type f | sort | xargs sha256sum) | tee $S/INVENTORY.sha256
date -u +%FT%TZ
