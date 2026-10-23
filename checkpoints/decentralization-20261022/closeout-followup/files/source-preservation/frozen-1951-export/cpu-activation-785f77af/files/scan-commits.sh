#!/bin/bash
set -euo pipefail
for repo in work/cpu-quota-activation-20261023 work/custody-v2-release-20261023 work/cpu-root-scheduler-quota-20261023/repo; do
 git -C "$repo" diff --cached --no-ext-diff --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact
 git -C "$repo" diff --cached --no-ext-diff --binary | python3 work/source-checkpoint-20261022/main-repo/.githooks/scan-crypto-keys.py --stdin
done
