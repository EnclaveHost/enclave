#!/bin/bash
# Secret scans of every file to be committed, with the checkpoint's own scanners/config (unchanged), plus the rewritten-literal check.
set -uo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 120 /home/steven/.local/bin/gitleaks dir . --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path logs/scan-gitleaks.json; g=$?; rm -f "$cfg"
find . -path ./.git -prune -o -type f -print0 | xargs -0 timeout -k 5 120 python3 "$CKR/.githooks/scan-crypto-keys.py" --files; k=$?
python3 - <<'PY'; l=$?
import pathlib, sys
OLD = bytes.fromhex('54696e666f696c'); bad = [str(p) for p in pathlib.Path('.').rglob('*') if p.is_file() and '.git' not in p.parts and (OLD in p.read_bytes() or OLD.lower() in p.read_bytes())]
print('literal files', bad); sys.exit(1 if bad else 0)
PY
echo "[scan] gitleaks=$g scan-crypto-keys=$k literal=$l"; [ $g -eq 0 ] && [ $k -eq 0 ] && [ $l -eq 0 ]
