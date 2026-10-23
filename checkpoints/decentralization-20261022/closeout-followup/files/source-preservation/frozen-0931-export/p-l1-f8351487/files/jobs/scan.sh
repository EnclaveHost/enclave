#!/bin/bash
# crypto-key scan (the project's scanner, by absolute path) + gitleaks (default rules) over EVERY commit of this repo,
# and gitleaks over the untracked-but-kept evidence/ and logs/ trees.
set -uo pipefail
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C"
SCAN=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/witness-cache-deadline-compose/repo/.githooks/scan-crypto-keys.py
git log --format='%H %an <%ae> / %cn <%ce> %s' --all
timeout -k 5 300 python3 "$SCAN" --range --all; s=$?
timeout -k 5 300 /home/steven/.local/bin/gitleaks git . --config .gitleaks.toml --log-opts="--all" --no-banner --redact --exit-code 1 --report-format json --report-path logs/gitleaks-git.json; g=$?
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir evidence --config .gitleaks.toml --no-banner --redact --exit-code 1; d=$?
echo "[scan] scan-crypto-keys=$s gitleaks-git=$g gitleaks-evidence=$d"; [ $s -eq 0 ] && [ $g -eq 0 ] && [ $d -eq 0 ]
