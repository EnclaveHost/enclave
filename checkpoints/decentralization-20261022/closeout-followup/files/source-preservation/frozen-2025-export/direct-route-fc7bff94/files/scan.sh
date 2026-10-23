#!/bin/bash
# Secret scans of this assessment directory with the checkpoint's own scanners/config (unchanged).
set -uo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 120 /home/steven/.local/bin/gitleaks dir . --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path scan-gitleaks.json; g=$?; rm -f "$cfg"
find . -maxdepth 1 -type f \( -name '*.md' -o -name '*.sh' -o -name '*.out' -o -name '*.log' \) -print0 | xargs -0 timeout -k 5 120 python3 "$CKR/.githooks/scan-crypto-keys.py" --files; k=$?
python3 -c "import sys;OLD=bytes.fromhex('54696e666f696c');d=open('RESULT.md','rb').read();sys.exit(1 if OLD in d or OLD.lower() in d else 0)"; l=$?
echo "[scan] gitleaks=$g scan-crypto-keys=$k literal=$l"; [ $g -eq 0 ] && [ $k -eq 0 ] && [ $l -eq 0 ]
