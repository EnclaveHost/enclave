#!/bin/bash
# scan.sh: read-only pre-commit scan of this repository's files with the checkpoint's own scanners and config (no allowlist added).
set -uo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
cfg=$(mktemp); git -C "$CKR" show dfb4b55e627ebd95b647abebf09627296f099862:.gitleaks.toml > "$cfg"
st=$(mktemp -d); find . -path ./.git -prune -o -path ./logs -prune -o -type f -print | while read -r f; do mkdir -p "$st/$(dirname "$f")"; cp "$f" "$st/$f"; done
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir "$st" --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path logs/scan-gitleaks.json; g=$?
find "$st" -type f -print0 | xargs -0 timeout -k 5 300 python3 "$CKR/.githooks/scan-crypto-keys.py" --files; k=$?
L=$(python3 -c "print(bytes.fromhex('54696e666f696c').decode())"); grep -rli "$L" "$st" && lit=1 || lit=0
rm -rf "$st" "$cfg"; echo "[scan] gitleaks=$g scan-crypto-keys=$k literal=$lit"; [ $g -eq 0 ] && [ $k -eq 0 ] && [ $lit -eq 0 ]
