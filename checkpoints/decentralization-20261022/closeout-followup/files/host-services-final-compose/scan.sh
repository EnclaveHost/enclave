#!/usr/bin/env bash
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-services-final-compose
cd "$H/candidate"; R=427780bbc0fc524f8091893614eae8a653518139..HEAD
git log --format='%H %an <%ae> / %cn <%ce> %s' $R
timeout -k 5 300 python3 .githooks/scan-crypto-keys.py --range $R; s=$?
cfg=$(mktemp); git show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config "$cfg" --log-opts="$R" --no-banner --redact --exit-code 1 --report-format json --report-path "$H/gitleaks-range.json"; g=$?; rm -f "$cfg"
echo "[scan] scan-crypto-keys=$s gitleaks=$g"; [ $s -eq 0 ] && [ $g -eq 0 ]
