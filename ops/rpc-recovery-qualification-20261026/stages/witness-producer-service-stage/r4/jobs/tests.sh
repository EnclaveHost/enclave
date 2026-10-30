#!/bin/bash
# witness-producer-service-stage/r4 (PREPARED by Claude; NOT run by Claude): the FROZEN r3 producer suite (10, unchanged file) plus the
# corrected forward-chain suite on r3 (7) in ONE private network namespace (lo with 10.0.2.2/32 and 10.0.2.15/32). No node, no network.
#   bash jobs/q-exit-status.sh witness-producer-r4 512 unshare -Urn bash witness-producer-service-stage/r4/jobs/tests.sh
# PASS = test_witness_producer_r3 "Ran 10 tests" OK AND test_forward_chain_r4 "Ran 7 tests" OK, nothing skipped; every input pin intact.
# Root 1604: the archived r14 witness-r2 SHA256SUMS also lists bridge/__pycache__/*.pyc, which is absent (never shipped); that
# archive is NOT re-verified as a whole and never edited or completed: the bridge SOURCE is pinned directly to its reviewed sha
# (which is also its own line in that SHA256SUMS).
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/witness-producer-service-stage/r4; WP=$W/witness-producer-service-stage
BR=$W/source/ops/rpc-witness-r14-20261026/witness-r2
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
die() { echo "PRETEST: $*"; exit 9; }
ip link set lo up && ip addr add 10.0.2.2/32 dev lo && ip addr add 10.0.2.15/32 dev lo || die "needs its own network namespace (unshare -Urn)"
ip -4 route | grep -v "dev lo" | grep -q . && die "network route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r4 != SHA256SUMS"
for p in "r1:1efa5c8557fad0cd409f4106cbbbb7505c3e43564b3ac9c12d711d5bf43e81c2" "r2:07084e7a5a9310c8d4b42c787647472b161d6f61c6010c5e96297f74186678c0" \
         "r3:816417f4e4cf09b2bf3acbcf5418e43596c3732d937f718da9b008cf8d3e14fe"; do
  d=${p%%:*}; h=${p#*:}
  [ "$(sha256sum < $WP/$d/SHA256SUMS | cut -c1-64)" = "$h" ] && (cd $WP/$d && sha256sum -c --quiet SHA256SUMS) || die "$d changed (must stay frozen)"
done
BSHA=cb9765418d30d238ded384c6908462516d153161f17631f28c7247905198fc9d
[ -f $BR/bridge/witness_rpc_bridge.py ] && [ ! -L $BR/bridge/witness_rpc_bridge.py ] || die "bridge source missing or a symlink"
[ "$(sha256sum < $BR/bridge/witness_rpc_bridge.py | cut -c1-64)" = $BSHA ] || die "bridge source is not the reviewed $BSHA"
grep -qx "$BSHA  ./bridge/witness_rpc_bridge.py" $BR/SHA256SUMS || die "the archive's own SHA256SUMS does not list the reviewed bridge sha"
[ -x /usr/bin/prlimit ] && /usr/bin/prlimit --help | grep -q -- --fsize || die "/usr/bin/prlimit with --fsize missing"
[ -x /usr/lib/systemd/systemd-socket-proxyd ] && [ -x /usr/bin/systemd-socket-activate ] || die "systemd-socket-proxyd/activate missing"
[ -r /home/steven/.local/state/enclave-rpc-production/manifest.json ] || die "VM manifest unreadable (read only)"
nobc() { [ -z "$(find $S $WP/r1 $WP/r2 $WP/r3 -path '*/runs' -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ]; }
nobc || die "bytecode in a stage"
rc=0
run() { local n=$1 f=$2 want=$3
  (cd $O && env -i PATH=$PATH TEST_TMP=$O/tmp timeout -k 5 600 python3 -I -B $f) > $O/$n.txt 2>&1; local r=$?
  tail -3 $O/$n.txt
  if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx OK && ! grep -q skipped $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi; }
run test_witness_producer_r3 $WP/r3/tests/test_witness_producer_r3.py 10
run test_forward_chain_r4 $S/tests/test_forward_chain_r4.py 7
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## r4 changed during the run"; rc=1; }
for d in r1 r2 r3; do (cd $WP/$d && sha256sum -c --quiet SHA256SUMS) || { echo "## $d changed during the run"; rc=1; }; done
nobc || { echo "## bytecode written during the run"; rc=1; }
rm -rf $O/tmp; echo "## witness-producer-r4 rc=$rc"; exit $rc
