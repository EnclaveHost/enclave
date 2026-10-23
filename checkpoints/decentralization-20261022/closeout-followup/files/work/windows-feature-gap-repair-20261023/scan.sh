#!/usr/bin/env bash
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-feature-gap-repair-20261023
cd "$H/candidate"; R=dda47a35008e989cc6e62c1a79f0fefde49b29f5..HEAD
git log --format='%H %an <%ae> / %cn <%ce> %s' $R
timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range $R; s=$?
cfg=$(mktemp); git show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config "$cfg" --log-opts="$R" --no-banner --redact --exit-code 1 --report-format json --report-path "$H/gitleaks-range.json"; g=$?; rm -f "$cfg"
echo "[scan] scan-crypto-keys=$s gitleaks=$g"; [ $s -eq 0 ] && [ $g -eq 0 ]
