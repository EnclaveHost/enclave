#!/bin/bash
set -euo pipefail
git -C work/custody-v2-live-20261023 diff --cached --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact --report-format json --report-path work/custody-v2-live-20261023/staged-gitleaks.json
