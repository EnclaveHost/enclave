#!/bin/bash
# crypto-key scan of the report repository's commits (same scanner as the source repo's pre-commit)
set -euo pipefail
cd "$(dirname "$0")/.."
git log --oneline
python3 repo/.githooks/scan-crypto-keys.py --range HEAD
echo "report scan rc=$?"
