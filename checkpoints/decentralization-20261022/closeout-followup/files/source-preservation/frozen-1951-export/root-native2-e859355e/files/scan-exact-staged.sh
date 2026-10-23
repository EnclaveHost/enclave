#!/bin/bash
set -euo pipefail
for repo in work/coupled-cpu-enforcement-20261023/root-validation work/custody-v2-live-20261023; do
 git -C "$repo" diff --cached --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact
 git -C "$repo" diff --cached --binary | python3 work/source-checkpoint-20261022/main-repo/.githooks/scan-crypto-keys.py --stdin
done
