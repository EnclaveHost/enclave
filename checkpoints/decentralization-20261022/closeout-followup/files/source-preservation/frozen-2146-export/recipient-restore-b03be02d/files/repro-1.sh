#!/bin/bash
# Reproducibility + release dir: rebuild the candidate a second time (must be byte-identical), stage the launcher release
# dir as a git archive of the commit (no node_modules) and diff it against production's metal-deabf8f90, write INVENTORY.
set -euo pipefail
cd "$(dirname "$0")"
R=$PWD/repo; S=$PWD/stage; P=/home/steven/enclave-prod
NEW=$(git -C $R rev-parse HEAD); SHORT=${NEW:0:9}
[ ! -e $S/repro-$SHORT ] && [ ! -e $S/metal-$SHORT ] || { echo "already staged"; exit 2; }
(cd $R && python3 metal/overlay-control-image.py $P/dist-sdshield-2857356cd $S/repro-$SHORT $NEW) >/dev/null
for f in initramfs.cpio.gz vmlinuz cmdline manifest.json; do cmp -s $S/repro-$SHORT/$f $S/dist-leasegas-$SHORT/$f && echo "REPRODUCIBLE $f" || { echo "NOT-REPRODUCIBLE $f"; exit 1; }; done
rm -rf $S/repro-$SHORT
mkdir $S/metal-$SHORT; git -C $R archive $NEW | tar -x -C $S/metal-$SHORT
[ ! -e $S/metal-$SHORT/node_modules ] || { echo "release dir carries node_modules"; exit 1; }
diff -rq $P/metal-deabf8f90 $S/metal-$SHORT | sort > $S/release-delta.txt || true
cat $S/release-delta.txt
printf 'Files %s/metal-deabf8f90/metal/guest/gsup.mjs and %s/metal-%s/metal/guest/gsup.mjs differ\nOnly in %s/metal-%s/test: metal-gsup-custody-env.test.mjs\nOnly in %s/metal-%s/test/helpers: gsup-env-harness.mjs\n' $P $S $SHORT $S $SHORT $S $SHORT | sort > $S/release-delta.expected
cmp -s $S/release-delta.txt $S/release-delta.expected && echo "RELEASE-DELTA-EXACT" || { echo "RELEASE-DELTA-UNEXPECTED"; exit 1; }
(cd $S && find dist-leasegas-$SHORT -type f | sort | xargs sha256sum; (cd metal-$SHORT && find . -type f | sort | xargs sha256sum) | sha256sum | sed "s#  -#  metal-$SHORT/(tree digest: sha256 of the sorted per-file sha256 list)#") > $S/INVENTORY.sha256
cat $S/INVENTORY.sha256
