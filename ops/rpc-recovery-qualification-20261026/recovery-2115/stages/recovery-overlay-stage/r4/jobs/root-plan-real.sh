#!/bin/bash
# recovery-overlay-stage/r4 REAL PLAN (prepared by Claude 1660/1674; NOT run by Claude). OFFLINE: reads only the LOCAL copied journal and
# root's verifier/candidate JSON (all sha-pinned); never the USB, the image, a device or a mount. Writes one plan dir. Root:
#   bash jobs/q-exit-status.sh rov-r4-plan 256 unshare -Urn bash recovery-overlay-stage/r4/jobs/root-plan-real.sh
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r4/jobs/common.sh
[ "$(id -u)" = 0 ] && [ "$(awk '{print $2}' /proc/self/uid_map)" != 0 ] || [ "$(id -u)" != 0 ] || die "never real root"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ "$(sha256sum < $P/ext4-recovery-checksum-stage/r2/ext4_candidate_checksums.py | cut -c1-64)" = $CHECKER_SHA ] || die "frozen checker changed"
J=$P/logs/base-journal-copy-1626/journal-8.bin; JSHA=d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073
R=$P/journal-recovery-verifier-stage/r1/runs/verify-20261026T203253Z-2318746/result.json; RSHA=f2ea7adcf3e696989e970759ee37e95989fea4f66670c2d277389201f184e8bf
C=$P/ext4-recovery-checksum-stage/r2/runs/real-20261026T203730Z-2323458/ext4-candidate-checksums.json; CSHA=70180b22ac5a905eb415caec8c8c7014cbaa8c3f6201cd577ee2d02979de9200
O=$S/runs/plan-real-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $S/runs && chmod 0700 $S/runs
env -i PATH=$PATH LC_ALL=C timeout -k 10 1800 python3 -I -B $S/overlay_plan.py real \
  --journal $J --journal-sha256 $JSHA --result $R --result-sha256 $RSHA --candidates $C --candidates-sha256 $CSHA \
  --uuid 11c6bbac-f823-4052-a87a-066eed6ad590 --fs-blocks 976562500 --ino 1950053 --gen 3326586236 --size 1138166333440 \
  --inode-table-block 499122230 --inode-offset 1024 --dir-ino 1949710 --dir-gen 1611750745 --dir-block 499122346 \
  --name mdbx.dat --path /data/db/mdbx.dat --out $O; rc=$?
[ $rc = 0 ] && sha256sum $O/plan.json
echo "## outputs $O"; echo "## rov-r4-plan rc=$rc"; exit $rc
