#!/bin/bash
# witness-placement r2 offline harness (PREPARED by Claude; NOT run by Claude): the RPC-VM-side forward chain, with the REAL
# systemd-socket-proxyd and the FROZEN r1 producer, inside a private network namespace (10.0.2.2 and 10.0.2.15 on lo only).
# The node tests of the transport patch run in root's merged composition (history r3 + integrated r1 +
# patches/witness-placement-r2-vs-writer-integrated-r1.patch, result tree 58c9b92e): see README.md.
#   bash jobs/q-exit-status.sh witness-placement-r2 512 unshare -Urn bash witness-producer-service-stage/r2/jobs/tests.sh
# PASS = "Ran 6 tests" + OK, nothing skipped; r1 and r2 sums intact.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/witness-producer-service-stage/r2
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
ip link set lo up && ip addr add 10.0.2.2/32 dev lo && ip addr add 10.0.2.15/32 dev lo || { echo "needs its own network namespace (unshare -Urn)"; exit 9; }
ip -4 route | grep -v "dev lo" | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "r2 != SHA256SUMS"; exit 9; }
(cd $W/witness-producer-service-stage/r1 && sha256sum -c --quiet SHA256SUMS) || { echo "r1 changed (must stay frozen)"; exit 9; }
[ -x /usr/lib/systemd/systemd-socket-proxyd ] && [ -x /usr/bin/systemd-socket-activate ] && [ -x /usr/bin/prlimit ] || { echo "systemd-socket-proxyd/activate or prlimit missing"; exit 9; }
rc=0; n=test_forward_chain; want=6
(cd $O && env -i PATH=$PATH TEST_TMP=$O/tmp timeout -k 5 300 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx OK && ! grep -q skipped $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
[ -z "$(find $S $W/witness-producer-service-stage/r1 -path '*/runs' -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode written"; rc=1; }
rm -rf $O/tmp; echo "## witness-placement-r2 rc=$rc"; exit $rc
