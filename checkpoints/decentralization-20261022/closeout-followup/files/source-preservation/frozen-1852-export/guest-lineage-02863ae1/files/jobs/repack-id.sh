#!/bin/bash
set -euo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/resource-guest-lineage-20261023
B=/home/steven/enclave-bench/nucbox-public-web-20261005/runtime-public-web.cpio.gz
python3 -I $D/jobs/repack.py $B $D/scratch/identity.cpio
echo "gzip -n -9 identity: $(gzip -n -9 -c $D/scratch/identity.cpio | sha256sum | cut -d' ' -f1)  (baseline $(sha256sum < $B | cut -d' ' -f1))"
gzip --version | head -1
