#!/bin/bash
set -euo pipefail
node --check work/custody-operator-funding-options-20261023/bin/root-send.mjs
git -C work/custody-operator-funding-options-20261023 diff --cached --binary | /home/steven/.local/bin/gitleaks stdin --no-banner --redact --report-format json --report-path work/custody-operator-funding-options-20261023/logs/root-staged-scan.json
