#!/bin/bash
# crypto-key scan of the report repository's commits (the source repo's scanner) and of the source range again
set -euo pipefail
cd "$(dirname "$0")/.."
git log --oneline; python3 repo/.githooks/scan-crypto-keys.py --range HEAD; echo "report scan rc=$?"
cd repo; git log --oneline 36919aafe..HEAD; python3 .githooks/scan-crypto-keys.py --range 36919aafe..HEAD; echo "source scan rc=$?"
