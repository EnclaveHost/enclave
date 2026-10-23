#!/bin/bash
# gitleaks over the staged diff of this repository only (run through q.sh)
set -euo pipefail
cd "$(dirname "$0")"
git diff --cached --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact --report-format json --report-path logs/staged-gitleaks.json
