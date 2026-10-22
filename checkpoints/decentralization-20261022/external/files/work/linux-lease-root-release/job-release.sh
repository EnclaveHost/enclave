#!/bin/sh
# The staged launcher release dir (git archive of the scratch commit, no node_modules: production's layout) driven with a
# lease-gas host config and a fake QEMU; its fw_cfg installed by the staged IMAGE's bundle and loaded by the IMAGE's runtime.
set -e
L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release; S=$L/stage
export GIT_DIR=$S/scratch.git
C=$(git rev-parse HEAD); R=$S/metal-$(echo $C | cut -c1-9)
rm -rf $R $S/extract; mkdir -p $R
git archive $C | tar -x -C $R
# Older scratch commit included only the development dependency SYMLINK, absent from the source snapshot.
# Normalize the launcher archive to the dependency-free production layout. Never remove a real dependency directory.
python3 - "$R" "$L/tree" <<'PYCODE'
from pathlib import Path
import os,sys
p=Path(sys.argv[1])/'node_modules'; src=Path(sys.argv[2])/'node_modules'
if p.is_symlink():
    assert os.readlink(p)==os.readlink(src), 'unexpected dependency link'
    p.unlink()
assert not p.exists(), 'unexpected dependency directory in launcher release'
PYCODE
python3 $S/extract.py $S/dist-leasegas-$(echo $C | cut -c1-9)/initramfs.cpio.gz $S/extract
node $S/launcher-check.mjs $R $S/extract
rm -rf $S/extract
echo "RELEASE-DIR $R ($(find $R -type f | wc -l) files, no node_modules: $( [ -e $R/node_modules ] && echo NO || echo yes))"
echo RELEASE-OK
