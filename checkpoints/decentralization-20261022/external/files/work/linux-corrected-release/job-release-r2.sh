#!/bin/sh
# Release-only follow-up (immutable; r2), as root's r12: uses the EXISTING scratch commit 51516b778 and staged image
# (no rebuild, no re-overlay, no re-measure). Stage v1 passed everything up to its manifest check, which wrongly
# expected the dist manifest's own initramfs {sha256, bytes} to equal c083's; that check now excludes exactly those
# generated fields. Then the launcher release dir (git archive, no node_modules), its delta to root's staged
# metal-c083e27a8, and launcher-check against the corrected image's extract.
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; L=$W/linux-corrected-release; S=$L/stage; OLD=$W/linux-lease-root-release/stage
export GIT_DIR=$S/scratch.git
COMMIT=$(git rev-parse HEAD); SHORT=$(echo $COMMIT | cut -c1-9)
[ "$COMMIT" = 51516b77884bb87d948969568d2eca58ae1a7fba ] || { echo "unexpected commit $COMMIT"; exit 2; }
OUT=$S/dist-leasegas-$SHORT
[ "$(cat $OUT/MEASUREMENT)" = 9fcbd925ada7a67a7b175e933f83f10681be06d86fc4b6ad46000809f9e82628e28fee5a50e1a591e23082b25f0ca0b4 ] || { echo "unexpected measurement"; exit 2; }
python3 - $OLD/dist-leasegas-c083e27a8/manifest.json $OUT/manifest.json $OUT/initramfs.cpio.gz <<'PY'
import json,sys,hashlib,os
a,b=(json.load(open(p)) for p in sys.argv[1:3])
ia,ib=a.pop('initramfs'),b.pop('initramfs')
assert ib=={'sha256':hashlib.sha256(open(sys.argv[3],'rb').read()).hexdigest(),'bytes':os.path.getsize(sys.argv[3])} or (ib['sha256']==hashlib.sha256(open(sys.argv[3],'rb').read()).hexdigest() and ib['bytes']==os.path.getsize(sys.argv[3])),'initramfs record is not the staged file'
ca,cb=a.pop('controlOverlay'),b.pop('controlOverlay')
assert a==b,'manifest outside controlOverlay/initramfs differs'
fa={x['path']:x for x in ca.pop('files')}; fb={x['path']:x for x in cb.pop('files')}
assert ca.pop('commit')!=cb.pop('commit')
assert ca==cb,'controlOverlay fields differ beyond commit/files'
d=[p for p in sorted(set(fa)|set(fb)) if fa.get(p)!=fb.get(p)]
assert d==['/app/supervisor.js'],d
print('MANIFEST-DELTA-EXACT commit + /app/supervisor.js', fb['/app/supervisor.js']['sha256'], '+ its own initramfs record', ib['sha256'])
PY
R=$S/metal-$SHORT
[ ! -e $R ] || { echo "release dir exists; inspect"; exit 2; }
mkdir -p $R
git archive $COMMIT | tar -x -C $R
[ ! -e $R/node_modules ] && echo "RELEASE-NO-NODE_MODULES" || { echo RELEASE-HAS-NODE_MODULES; exit 1; }
diff -rq --no-dereference $OLD/metal-c083e27a8 $R > $L/release-delta.txt || true
cat $L/release-delta.txt
printf '%s\n' "Files $OLD/metal-c083e27a8/supervisor.js and $R/supervisor.js differ" "Only in $R/test: isolation-resume-shield-model.test.mjs" | sort > $L/release-delta.expected
sort $L/release-delta.txt | cmp -s - $L/release-delta.expected && echo RELEASE-DELTA-EXACT || { echo RELEASE-DELTA-UNEXPECTED; exit 1; }
rm -rf $S/extract
python3 $S/extract.py $OUT/initramfs.cpio.gz $S/extract
node $S/launcher-check.mjs $R $S/extract
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files)"
echo RELEASE-OK
