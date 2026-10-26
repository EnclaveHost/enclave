#!/bin/bash
# witness-producer-service-stage/r1 offline tests (PREPARED by Claude; NOT run by Claude). Loopback only, inside unshare -Urn (lo up),
# no node, no network, nothing produced. Uses the REAL r14 bridge module (sha-pinned), /usr/bin/prlimit, and the REAL pinned
# witness_fetch ELF of the combined-r1 root build (argument refusals only, before any connection).
#   bash jobs/q-exit-status.sh witness-producer-r1 512 unshare -Urn bash witness-producer-service-stage/r1/jobs/tests.sh
# PASS = "Ran 12 tests" + OK, nothing skipped; stage, combined-r1 and r14 witness-r2 sums intact; no bytecode in the stage.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/witness-producer-service-stage/r1
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -v '^127\.\|^local\|dev lo' | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r1 != SHA256SUMS"; exit 9; }
(cd $W/derivation-client-stage/combined-r1 && sha256sum -c --quiet SHA256SUMS) || { echo "combined-r1 changed"; exit 9; }
(cd $W/source/ops/rpc-witness-r14-20261026/witness-r2 && sha256sum -c --quiet SHA256SUMS) || { echo "r14 witness-r2 changed"; exit 9; }
[ -x /usr/bin/prlimit ] || { echo "/usr/bin/prlimit missing"; exit 9; }
nobc() { [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ]; }
nobc || { echo "bytecode in the stage"; exit 9; }
rc=0; n=test_witness_producer; want=12
(cd $O && env -i PATH=$PATH TEST_TMP=$O/tmp timeout -k 5 600 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx "OK" && ! grep -q "skipped" $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
nobc || { echo "## bytecode written during the run"; rc=1; }
rm -rf $O/tmp; echo "## witness-producer-r1 rc=$rc"; exit $rc
