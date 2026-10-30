#!/bin/bash
# witness-producer-service-stage/r3 offline tests (PREPARED by Claude; NOT run by Claude). Loopback only inside unshare -Urn (lo up);
# no node, no network, nothing produced. REAL child processes under the REAL /usr/bin/prlimit (--fsize/--core/--as/--cpu), the REAL
# r14 bridge module (sha-pinned). r1 and placement r2 must stay frozen.
#   bash jobs/q-exit-status.sh witness-producer-r3 512 unshare -Urn bash witness-producer-service-stage/r3/jobs/tests.sh
# PASS = "Ran 10 tests" + OK, nothing skipped; r1, r2 and r3 sums intact; no bytecode.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/witness-producer-service-stage/r3
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route | grep -v "dev lo" | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r3 != SHA256SUMS"; exit 9; }
for d in r1 r2; do (cd $W/witness-producer-service-stage/$d && sha256sum -c --quiet SHA256SUMS) || { echo "$d changed (must stay frozen)"; exit 9; }; done
(cd $W/source/ops/rpc-witness-r14-20261026/witness-r2 && sha256sum -c --quiet SHA256SUMS) || { echo "r14 witness-r2 changed"; exit 9; }
[ -x /usr/bin/prlimit ] && /usr/bin/prlimit --help | grep -q -- --fsize || { echo "/usr/bin/prlimit with --fsize missing"; exit 9; }
nobc() { [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ]; }
nobc || { echo "bytecode in the stage"; exit 9; }
rc=0; n=test_witness_producer_r3; want=10
(cd $O && env -i PATH=$PATH TEST_TMP=$O/tmp timeout -k 5 600 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx OK && ! grep -q skipped $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
nobc || { echo "## bytecode written during the run"; rc=1; }
rm -rf $O/tmp; echo "## witness-producer-r3 rc=$rc"; exit $rc
