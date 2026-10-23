#!/bin/bash
# which report-repo file gitleaks flags (redacted)
set -uo pipefail
cd "$(dirname "$0")/.."
gitleaks git --no-banner --redact -v . 2>&1 | grep -E "RuleID|File|Commit|Line|Secret|Match" ; exit 0
