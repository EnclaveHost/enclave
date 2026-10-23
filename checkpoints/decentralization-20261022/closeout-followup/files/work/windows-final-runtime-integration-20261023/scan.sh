#!/usr/bin/env bash
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
cd "$H/candidate"; R=1f19ad15aaa6200e1882d148f2b43b7c25fc7058..HEAD
git log --format='%H %an <%ae> / %cn <%ce> %s' $R
timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range $R; s=$?
cfg=$(mktemp); git show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config "$cfg" --log-opts="$R" --no-banner --redact --exit-code 1 --report-format json --report-path "$H/gitleaks-range.json"; g=$?; rm -f "$cfg"
echo "[scan] scan-crypto-keys=$s gitleaks=$g"; [ $s -eq 0 ] && [ $g -eq 0 ]
