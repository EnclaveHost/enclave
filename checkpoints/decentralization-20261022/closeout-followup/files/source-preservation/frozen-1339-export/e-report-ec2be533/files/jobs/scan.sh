#!/bin/bash
# crypto-key scan (the source repo's own scanner) + gitleaks over the new source commit and the report repository
set -uo pipefail
cd "$(dirname "$0")/.."
rc=0
echo "== source 349318a06..HEAD"; git -C repo log --oneline 349318a06..HEAD
(cd repo && python3 .githooks/scan-crypto-keys.py --range 349318a06..HEAD) || rc=1
echo "source crypto scan rc=$rc"
gitleaks git --no-banner --log-opts="349318a06..HEAD" repo || rc=1
echo "== report repo"; git log --oneline
python3 repo/.githooks/scan-crypto-keys.py --range HEAD || rc=1
gitleaks git --no-banner --config repo/.gitleaks.toml . || rc=1   # the source repo's own policy (allowlists anvil's public dev keys)
echo "scan rc=$rc"; exit $rc
