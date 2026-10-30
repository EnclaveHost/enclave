#!/bin/bash
# multipart-validation-view-stage/r4 PRODUCTION view import (PREPARED by Claude 1759; NOT run). Root, ONLY after (1) mvv-r4-tests PASS
# and (2) recovery-multipart r3 `status` for the production manifest shows all 265 parts committed + verified in CONFIRMED sessions:
#   bash jobs/q-exit-status.sh mvv-r4-import 256 bash multipart-validation-view-stage/r4/jobs/root-view-import.sh MANIFEST MANIFEST_SHA256 [hash]
# Run as the SAME user that owns the r3 target dirs/parts (r3 open_dir requires it). MANIFEST/SHA = exactly those of the r3 production
# runs. Reads records + lstat only (no part bytes) unless `hash` (a full 1.14 TB re-read against the recorded sha256s; schedule it).
# Writes ONLY a new 0700 view dir (view.vmdk + receipt.json, 0400) under r4/runs. Never chmods, opens for write, or moves a part.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin
MAN=${1:?MANIFEST}; MAN_SHA=${2:?MANIFEST_SHA256}; HASH=${3:-}
[ -z "$HASH" ] || [ "$HASH" = hash ] || { echo "third argument must be 'hash' or absent"; exit 2; }
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/multipart-validation-view-stage/r4
source "$S/jobs/pins.sh"; pins_ok || exit 9
R=$(ls -d "$S"/runs/tests-*/ 2>/dev/null | sort | tail -1)
[ -n "$R" ] && python3 -I -B -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("pass") is True and r.get("stageSums")==sys.argv[2] else 1)' \
  "$R/receipt.json" "$(sha256sum < $S/SHA256SUMS | cut -c1-64)" || { echo "REFUSED: no passing mvv-r4-tests receipt for these SUMS"; exit 9; }
V=$S/runs/view-$(date -u +%Y%m%dT%H%M%SZ)-$$
python3 -I -B "$S/production_import.py" import --manifest "$MAN" --manifest-sha256 "$MAN_SHA" --out-dir "$V" --expect-kind production; rc=$?
[ $rc = 0 ] && { python3 -I -B "$S/production_import.py" recheck --view-dir "$V" ${HASH:+--hash}; rc=$?; }
[ -f "$V/receipt.json" ] && sha256sum "$V/receipt.json" "$V/view.vmdk"
echo "## view $V"; echo "## mvv-r4-import rc=$rc"; exit $rc
