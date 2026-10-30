#!/bin/bash
# consumer-package-inputs-stage: ROOT job (PREPARED; not run by Claude). Package-mode qualification of the real consumer release with a
# corrected dependency harness. Bounded by the shared queue, the frozen package mode's own 768 MiB, and a PRIVATE MOUNT namespace:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   bash jobs/q-exit-status.sh consumer-package-inputs-1 768 unshare -Urnm bash consumer-package-inputs-stage/jobs/root-package-inputs.sh
# It verifies the frozen final-consumer-composition-stage (SHA256SUMS 320848ec) and its job (3692b655) byte-for-byte, applies
# patches/root-final-consumer.package-inputs.patch to a PRIVATE copy, requires the result to be the reviewed derivative (4ad09d4d), and
# runs it in `package` mode. The frozen stage and job are only read; outputs go to consumer-package-inputs-stage/runs.
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
NS=$P/consumer-package-inputs-stage; ST=$P/final-consumer-composition-stage
ORIG=3692b6558160d75962448f2d3ac78fc930b6f7636f02963f62a6e212c7320daa
DERIV=4ad09d4dff82a7fe0b66c5dbb3642ac668912698be13136648988fb7f076080e
ST_SUMS=320848ec8b9b71c15e9f57cbdd3aeb587136a6d0c1f4d926326f407842be210d
die() { echo "## SETUP: $*"; echo "## consumer-package-inputs rc=9"; exit 9; }
(cd $NS && sha256sum -c --quiet SHA256SUMS) || die "this stage != its SHA256SUMS"
[ "$(sha256sum < $ST/SHA256SUMS | cut -c1-64)" = $ST_SUMS ] && (cd $ST && sha256sum -c --quiet SHA256SUMS) || die "final-consumer-composition-stage is not the frozen 320848ec"
[ "$(sha256sum < $ST/jobs/root-final-consumer.sh | cut -c1-64)" = $ORIG ] && cmp -s $ST/jobs/root-final-consumer.sh $NS/patches/root-final-consumer.orig.sh \
  || die "frozen job is not 3692b655"
J=$(mktemp -d /tmp/cpi.XXXXXX) || die "mktemp"; trap 'rm -rf -- "$J"' EXIT
cp $ST/jobs/root-final-consumer.sh $J/job.sh && patch -s $J/job.sh < $NS/patches/root-final-consumer.package-inputs.patch || die "patch does not apply to 3692b655"
[ "$(sha256sum < $J/job.sh | cut -c1-64)" = $DERIV ] && cmp -s $J/job.sh $NS/patches/root-final-consumer.package-inputs.sh || die "patched job is not the reviewed derivative"
mkdir -p $J/probe && mount --bind $J/probe $J/probe 2>/dev/null && umount $J/probe || die "no private mount namespace: run under unshare -Urnm"
echo "## harness: consumer-package-inputs-stage = frozen job $ORIG + patch $(sha256sum < $NS/patches/root-final-consumer.package-inputs.patch | cut -c1-12) -> $DERIV"
echo "## node_modules: real dependency directories, read-only bind mounts inside each exported side (no symlink)"
bash $J/job.sh package; rc=$?
echo "## consumer-package-inputs rc=$rc"; exit $rc
