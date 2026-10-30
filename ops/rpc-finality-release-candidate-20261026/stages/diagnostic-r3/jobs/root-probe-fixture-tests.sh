#!/bin/bash
# r3 probe fixture tests: root's LOCAL, OFFLINE job (PREPARED; NOT run by Claude). Exactly 7 tests (tests/test_probes.py) drive the ACTUAL
# r3 guest/el_probe.mjs + guest/helios_probe.mjs with node against an in-process 127.0.0.1 mock JSON-RPC server, and tools/status.py.
# The keccak dependency is the pinned @noble/hashes sha3.js from the FROZEN canary r3 bundle (r3's own assembler + R10 pins), in a
# private 0700 mktemp dir removed on ANY exit. No network (unshare -rn), no guest, no production endpoint.
#   python3 -u ../claude-test-queue.py --mib 256 --log guest-call-timeout-diagnostic-stage/r3/logs/root-probe-fixture-tests.guard -- unshare -rn bash guest-call-timeout-diagnostic-stage/r3/jobs/root-probe-fixture-tests.sh
# On PASS writes logs/probe-fixture-<stamp>/RESULT = "PASS probe-fixture Ran 7 r3-sums <sha of r3 SHA256SUMS>" (the diagnostic job's gate).
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$P/guest-call-timeout-diagnostic-stage/r3; R3=$P/guest-capture-canary-stage/r3
OUT=$S/logs/probe-fixture-$(date -u +%Y%m%dT%H%M%SZ)-$$; PW=""
die() { echo "## SETUP: $*"; echo "## probe-fixture rc=9"; exit 9; }
trap '[ -n "$PW" ] && rm -rf --one-file-system -- "$PW"' EXIT
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "diagnostic r3 != SHA256SUMS"; SUMS=$(sha256sum < $S/SHA256SUMS | cut -c1-64)
[ "$(sha256sum < $R3/SHA256SUMS | cut -c1-64)" = 9367c877519d4e34867461ebbea9aafcd478109b1d77557d01d8c060eb67c882 ] || die "canary r3 is not the frozen 9367c877"
(cd $R3 && sha256sum -c --quiet SHA256SUMS) || die "canary r3 changed"
[ ! -e "$OUT" ] && mkdir -p "$OUT" || die "output dir"
PW=$(mktemp -d /tmp/probefix.XXXXXXXX) && chmod 0700 $PW || die "private dir"
python3 -I $R3/tools/assemble_canary_bundle.py $PW > $PW/assemble.json || die "canary r3 bundle assembly (pins)"
K=$PW/bundle/opt/finality/deps/node_modules/@noble/hashes/sha3.js; [ -f $K ] || die "pinned noble sha3.js missing from the bundle"
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
(cd $S && env -i PATH=/usr/bin:/bin TMPDIR=$PW HOME=$PW NODE=$NODE K=file://$K timeout 600 /usr/bin/python3 -I -B tests/test_probes.py -v < /dev/null) > $OUT/probe-fixture.txt 2>&1; r=$?
f=$OUT/probe-fixture.txt; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
if [ $r = 0 ] && [ "$last" = OK ] && [ "$ran" = 7 ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then
  echo "PASS probe-fixture Ran 7 r3-sums $SUMS" | tee $OUT/RESULT; rc=0
else echo "## FAIL: probe-fixture: rc $r, Ran ${ran:-?} (expected 7), last ${last:-none} (see $f)"; rc=1; fi
echo "## probe-fixture rc=$rc"; exit $rc
