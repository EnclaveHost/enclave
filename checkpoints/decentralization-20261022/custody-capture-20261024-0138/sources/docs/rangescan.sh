#!/bin/bash
# rangescan.sh: post-commit scan of every commit in this repository (gitleaks git + scan-crypto-keys range), checkpoint config.
set -uo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
cfg=$(mktemp); git -C "$CKR" show dfb4b55e627ebd95b647abebf09627296f099862:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path logs/rangescan-gitleaks.json; g=$?
A=$(git rev-list --max-parents=0 HEAD); k=0
timeout -k 5 300 python3 "$CKR/.githooks/scan-crypto-keys.py" --files $(git ls-files) || k=$?
rm -f "$cfg"; echo "[rangescan] gitleaks-all-commits=$g scan-crypto-keys-tracked=$k"; [ $g -eq 0 ] && [ $k -eq 0 ]
