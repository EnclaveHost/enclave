#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
cd "$P"
[ "$(cat logs/rov-r9-tests.rc)" = 0 ]
python3 - <<'PY'
import json
r=json.load(open('recovery-overlay-stage/r9/runs/tests-20261026T214140Z-2384790/receipt.json'));assert r['pass'] and r['noMountsLeft'] and r['peersUnchanged']
PY
python3 jobs/root-recovery-probe-1720.py
R=$P/logs/recovery-diagnostic-request-1720.json
H=$(sha256sum "$R" | cut -c1-64)
bash recovery-overlay-stage/r9/jobs/root-diagnostic-expose.sh "$R" "$H" 1800
