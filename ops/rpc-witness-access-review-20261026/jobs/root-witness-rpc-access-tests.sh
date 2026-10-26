#!/bin/bash
# witness-rpc-access-stage: bounded OFFLINE tests (fake node IPC; loopback only). Root, via the shared queue:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh witness-rpc-access-1 512 unshare -Urn bash witness-rpc-access-stage/jobs/root-witness-rpc-access-tests.sh
set -uo pipefail; export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/witness-rpc-access-stage; C=$P/base-finality-proof-stage/r13-manifest-final
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## witness-rpc-access rc=9 (no loopback)"; exit 9; }
ip -o route 2>/dev/null | grep -v ' lo ' | grep -q . && { echo "## witness-rpc-access rc=9 (network)"; exit 9; }
(cd $ST && sha256sum -c --quiet SHA256SUMS) || { echo "## witness-rpc-access rc=9 (stage changed)"; exit 9; }
[ "$(sha256sum < $C/SHA256SUMS | cut -c1-64)" = 80cea88861f069540bd6d4214cdcd9e2020c897558f7dd4badcf572edecccd60 ] && (cd $C && sha256sum -c --quiet SHA256SUMS) || { echo "## witness-rpc-access rc=9 (candidate changed)"; exit 9; }
T=$(mktemp -d); cp $C/wrapper/chain_service.py $T/x && (cd $T && patch -s x < $ST/patches/wrapper_chain_service.py.patch) && cmp -s $T/x $ST/overlay/wrapper/chain_service.py || { echo "## witness-rpc-access rc=9 (overlay != candidate + patch)"; exit 9; }; rm -rf $T
OUT=$ST/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $OUT/tmp
(cd $ST && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 600 /usr/bin/python3 -I -B tests/test_witness_rpc_access.py -v < /dev/null) > $OUT/tests.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+ tests' $OUT/tests.txt | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $OUT/tests.txt | tail -1)
if [ $r = 0 ] && [ "$ran" = 10 ] && [ "$last" = OK ] && ! grep -qE 'skipped|expected failure' $OUT/tests.txt; then echo "PASS witness-rpc-access Ran $ran"; rc=0
else echo "## FAIL: rc $r Ran ${ran:-?} last ${last:-none} (see $OUT/tests.txt)"; rc=1; fi
echo "## witness-rpc-access SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## witness-rpc-access rc=$rc"; exit $rc
