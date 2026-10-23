#!/bin/bash
# key scans: the source commits on 14d1e495, and the report repository
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE/repo"; git log --oneline 14d1e4954..HEAD; python3 .githooks/scan-crypto-keys.py --range 14d1e4954..HEAD; echo "source scan rc=$?"
cd "$HERE"; git add -A -n . >/dev/null; python3 repo/.githooks/scan-crypto-keys.py --range HEAD; echo "report scan rc=$?"
