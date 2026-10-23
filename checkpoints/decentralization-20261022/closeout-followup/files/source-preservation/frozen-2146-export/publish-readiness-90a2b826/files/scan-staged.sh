#!/bin/bash
# gitleaks + the crypto-key scanner over this repository's staged files only (run through q.sh)
set -euo pipefail
cd "$(dirname "$0")"
git diff --cached --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact --exit-code 1 --report-format json --report-path logs/staged-gitleaks.json
git diff --cached --name-only -z | xargs -0 python3 /home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo/.githooks/scan-crypto-keys.py --files
