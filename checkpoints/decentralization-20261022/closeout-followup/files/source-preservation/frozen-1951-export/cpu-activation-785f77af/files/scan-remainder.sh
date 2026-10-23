#!/bin/bash
set -euo pipefail
git -C work/custody-v2-release-20261023 diff --cached --no-ext-diff --binary | python3 work/source-checkpoint-20261022/main-repo/.githooks/scan-crypto-keys.py --stdin
git -C work/cpu-root-scheduler-quota-20261023/repo diff --cached --no-ext-diff --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact
git -C work/cpu-root-scheduler-quota-20261023/repo diff --cached --no-ext-diff --binary | python3 work/source-checkpoint-20261022/main-repo/.githooks/scan-crypto-keys.py --stdin
