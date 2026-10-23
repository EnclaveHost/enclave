#!/bin/bash
set -uo pipefail
git -C work/custody-v2-release-20261023 diff --cached --no-ext-diff --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact --report-format json --report-path work/custody-v2-release-20261023/scan-findings.json
