#!/bin/bash
# 40-upgrade-v28.sh - final recipe §C2: upgrade 27 -> 28 (fence c67ffa4d -> c2-enclave 2c0e5b06) with controller 1543577f
# (ROOT ONLY; prepared, never run by its author).
# Requires the v27 post-checks to have PASSED twice, at least 600 s apart, with NRestarts unchanged (the soak).
# The upgrade enrols NO account in CAS; 50-postcheck.sh 28 requires casEnrolledAccounts=0. No retry, no rollback here.
source "$(dirname "$0")/lib.sh"
source "$P/upgrade-common.sh"
python3 -B - "$OUT" <<'PY' || die "the v27 soak is not proven: run 50-postcheck.sh 27 twice, >= 600 s apart, both PASS with equal NRestarts"
import sys
from pathlib import Path
ms = [dict(l.strip().split("=", 1) for l in p.read_text().split() if "=" in l) for p in sorted(Path(sys.argv[1]).glob("*.50.27.PASS"))]
ok = len(ms) >= 2 and int(ms[-1]["epoch"]) - int(ms[0]["epoch"]) >= 600 and len({m["NRestarts"] for m in ms}) == 1
print("v27 post-check passes:", ms, "soak", "OK" if ok else "NOT PROVEN")
sys.exit(0 if ok else 1)
PY
run_step 28 upgrade-c2 "$H_C2" "$H_FENCE" 27
