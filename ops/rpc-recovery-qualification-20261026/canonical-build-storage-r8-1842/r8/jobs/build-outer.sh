#!/bin/bash
# base-state-readonly-stage/r8 OUTER build entry (PREPARED by Claude 1839; NOT run by Claude). Root, ONLY after all 265 parts are committed AND
# independently verified (CONFIRMED) and the r8 guard-tests + ns-tests receipts passed; the exclusive 4096 MiB main lane:
#   bash jobs/q-exit-status.sh bsro-r8-preflight 4096 bash base-state-readonly-stage/r8/jobs/build-outer.sh preflight
#   bash jobs/q-exit-status.sh bsro-r8-build     4096 bash base-state-readonly-stage/r8/jobs/build-outer.sh build
# Runs as the REAL user (no unshare here): jobs/bsro_gate.py outer does every gate, then `unshare -Urnm bash jobs/build.sh ...`, the
# bounded capture and the authenticated receipt (see its docstring). Root writes: S/runs/MODE-ID/{build-output.txt, receipt.json} (<= 1 MiB
# each) + one symlink. Exit: 3 refused (nothing started); a nonzero build rc is preserved (70 /vm floor, 71 scratch cap, 72 timeout, 73
# cancelled, 9 precondition); build rc 0 -> 0 only if the receipt verifies, else 10.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
exec python3 -I -B "$S/jobs/bsro_gate.py" outer "${1:?build|preflight}"
