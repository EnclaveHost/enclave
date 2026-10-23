#!/bin/bash
set -euo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/resource-guest-lineage-20261023
rm -rf $D/scratch/f86fb512; mkdir -p $D/scratch/f86fb512
python3 -I $D/jobs/extract.py /home/steven/enclave-bench/nucbox-public-web-20261005/runtime-public-web.cpio.gz $D/scratch/f86fb512
cd $D/scratch/f86fb512
for f in init monitor plat/domexec plat/front plat/domprobe $(find . -type f -perm -u+x | sed 's|^\./||' | grep -v '^plat/rt/' | sort -u); do
  [ -f "$f" ] || continue
  echo "=== $f $(sha256sum < $f | cut -c1-16) $(file -b $f | cut -c1-90)"
  go version -m "$f" 2>/dev/null || echo "(no go buildinfo)"
done
