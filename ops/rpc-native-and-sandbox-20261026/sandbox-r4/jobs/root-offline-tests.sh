#!/bin/bash
# bootstrap-systemd-canary-stage/r4: bounded OFFLINE tests (no systemd, no guest, no network). Root, via the shared queue:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh sdcanary-offline-1 512 unshare -Urn bash bootstrap-systemd-canary-stage/r4/jobs/root-offline-tests.sh
# Inputs are the PROVISIONAL r13 composition (read-only; shas printed); the canary's final pins stay null until r13-final qualifies.
set -uo pipefail; export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/bootstrap-systemd-canary-stage/r4; R13=$P/base-finality-proof-stage/r13-manifest-final
LIVE=$P/source/ops/rpc-launcher-handshake-validated-20261026/inputs/launcher-service-audit-0143/base-unit.out
[ "$(sha256sum < $R13/SHA256SUMS | cut -c1-64)" = "$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["stageSha256sums"])' $ST/FINAL-PINS.json)" ] && (cd $R13 && sha256sum -c --quiet SHA256SUMS) || { echo "## sdcanary-offline rc=9 (inputs are not the bound stage)"; exit 9; }
(cd $ST && sha256sum -c --quiet SHA256SUMS) || { echo "## sdcanary-offline rc=9 (stage changed)"; exit 9; }
ip -o route 2>/dev/null | grep -q . && { echo "## sdcanary-offline rc=9 (network)"; exit 9; }
for f in $LIVE $R13/units/enclave-base-holder.service.d/60-release-mode.conf $R13/units/enclave-base-finality-reproof.service $R13/wrapper/chain_service.py; do sha256sum $f; done
OUT=$ST/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $OUT/tmp
(cd $ST && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp CANARY_LIVE=$LIVE CANARY_DROPIN=$R13/units/enclave-base-holder.service.d/60-release-mode.conf \
  CANARY_REPROOF=$R13/units/enclave-base-finality-reproof.service CANARY_WRAPPER=$R13/wrapper/chain_service.py \
  timeout 600 /usr/bin/python3 -I -B tests/test_systemd_canary.py -v < /dev/null) > $OUT/offline.txt 2>&1; r=$?
ran=$(grep -oE '^Ran [0-9]+ tests' $OUT/offline.txt | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)' $OUT/offline.txt | tail -1)
if [ $r = 0 ] && [ "$ran" = 17 ] && [ "$last" = OK ] && ! grep -qE 'skipped|expected failure' $OUT/offline.txt; then echo "PASS sdcanary-offline Ran $ran"; rc=0
else echo "## FAIL: rc $r Ran ${ran:-?} last ${last:-none} (see $OUT/offline.txt)"; rc=1; fi
echo "## sdcanary-offline SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## sdcanary-offline rc=$rc"; exit $rc
