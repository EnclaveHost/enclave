#!/bin/bash
# crypto-key scanner + gitleaks over the compose root and both composed repos (all commits), plus render/
set -uo pipefail
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C"
SCAN=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/witness-cache-deadline-compose/repo/.githooks/scan-crypto-keys.py
rc=0
for r in . s p; do
  echo "== $r"; (cd "$r" && git log --format='%h %an <%ae> %s' -3)
  (cd "$r" && timeout -k 5 300 python3 "$SCAN" --range --all) || rc=1
  timeout -k 5 300 /home/steven/.local/bin/gitleaks git "$r" --config .gitleaks.toml --log-opts="--all" --no-banner --redact --exit-code 1 || rc=1
done
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir render --config .gitleaks.toml --no-banner --redact --exit-code 1 || rc=1
echo "[scan] rc=$rc"; exit $rc
