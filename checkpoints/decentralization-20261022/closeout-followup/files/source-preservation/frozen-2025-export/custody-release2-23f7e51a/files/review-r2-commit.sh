#!/bin/bash
set -uo pipefail
git -C work/custody-v2-release-20261023 diff 44bf8f4..da6e349 --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact --report-format json --report-path work/custody-v2-release-20261023/scan-findings-r2-commit.json
leak=$?
git -C work/custody-v2-release-20261023 diff 44bf8f4..da6e349 --binary | python3 work/source-checkpoint-20261022/main-repo/.githooks/scan-crypto-keys.py --stdin
crypto=$?
printf 'gitleaks_exit=%s crypto_exit=%s\n' "$leak" "$crypto"
exit "$crypto"
