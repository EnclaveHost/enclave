#!/bin/bash
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-guest-import-recovery
(cd "$S" && sha256sum -c --quiet SHA256SUMS)
python3 "$S/tools/make-run2-files.py" --check "$S"
python3 "$S/host/test-guest-build-watch-2.py"
bash "$S/host/transfer-import-recovery.sh"
