#!/bin/bash
set -euo pipefail
ROOT=/home/steven/Documents/Codex/2026-10-18/wo
for rel in work/coupled-cpu-enforcement-20261023/root-validation work/custody-v2-live-20261023; do
 git -C "$ROOT/$rel" diff --cached --binary | /home/steven/.local/bin/gitleaks stdin --config "$ROOT/work/enclave/.gitleaks.toml" --no-banner --redact --exit-code 1
 done
