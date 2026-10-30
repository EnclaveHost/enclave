#!/bin/bash
# rpc-memory-recovery-stage/r1: ROOT offline tests (prepared by Claude; NOT run by Claude). Reads the live launcher/manifest/units
# (copies them into temp dirs); never calls systemctl (stubbed), QMP, qemu-nbd/nbdfuse/debugfs, the VM or the OS disk.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh rpc-memory-r1 256 bash rpc-memory-recovery-stage/r1/jobs/root-rpc-memory-r1-tests.sh
# NOT under `unshare -U`: the launcher's manifest uid check (1000) must see the real uid. No network is used. HOME is not set.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/rpc-memory-recovery-stage/r1
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## INVALID: $*"; echo "## rpc-memory-r1 rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $OUT/tmp || die "output dir"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
L=/home/steven/.local/state/enclave-rpc-production; U=/home/steven/.config/systemd/user
[ "$(sha256sum < $L/provision_vm.py | cut -c1-64)" = 38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7 ] \
  && [ "$(sha256sum < $L/manifest.json | cut -c1-64)" = a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441 ] \
  || die "the live launcher/manifest are no longer the pinned originals (installed already?)"
sha256sum $L/provision_vm.py $L/manifest.json $U/enclave-rpc-production-vm.service $U/enclave-rpc-production-guard.service > $OUT/live-before.sha256
(cd $S && TMPDIR=$OUT/tmp timeout -k 10 600 python3 -I -m unittest -v test_rpc_memory_r1) > $OUT/tests.out 2>&1; rc=$?
tail -n 5 $OUT/tests.out
grep -q "^Ran 11 tests" $OUT/tests.out && grep -q "^OK$" $OUT/tests.out || { [ $rc -eq 0 ] && rc=1; }
sha256sum -c --quiet $OUT/live-before.sha256 || { echo "## LIVE FILES CHANGED during the tests"; rc=1; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
rm -rf $OUT/tmp
echo "## outputs: $OUT"; echo "## rpc-memory-r1 rc=$rc"; exit $rc
