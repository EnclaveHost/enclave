#!/bin/sh
# The staged launcher release dir (git archive of the scratch commit, no node_modules: production's layout) driven with a
# lease-gas host config and a fake QEMU; its fw_cfg installed by the staged IMAGE's bundle and loaded by the IMAGE's runtime.
set -e
L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-activation; S=$L/stage
export GIT_DIR=$S/scratch.git
C=$(git rev-parse HEAD); R=$S/metal-$(echo $C | cut -c1-9)
rm -rf $R $S/extract; mkdir -p $R
git archive $C | tar -x -C $R
python3 $S/extract.py $S/dist-leasegas-$(echo $C | cut -c1-9)/initramfs.cpio.gz $S/extract
node $S/launcher-check.mjs $R $S/extract
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files, no node_modules: $( [ -e $R/node_modules ] && echo NO || echo yes))"
echo RELEASE-OK
