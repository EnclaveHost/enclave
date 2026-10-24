#!/bin/bash
set -euo pipefail
base=/home/steven/Documents/Codex/2026-10-18/wo
cd "$base/work/metal0-expired-recovery-20261024"
ck="$base/work/source-checkpoint-20261022/main-repo"
/home/steven/.local/bin/gitleaks dir . --config "$ck/.gitleaks.toml" --no-banner --redact
python3 "$ck/.githooks/scan-crypto-keys.py" --files reclaim.mjs run.mjs deps.mjs guest-health.mjs observe-claims.mjs runtime-guard.mjs test/reclaim.test.mjs test/mutate.py README.md
git add -- .gitignore reclaim.mjs run.mjs deps.mjs guest-health.mjs observe-claims.mjs runtime-guard.mjs test/reclaim.test.mjs test/mutate.py README.md preserve.sh
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -m 'Prepare bounded app-paid recovery for expired metal0 leases' >/dev/null
git rev-parse HEAD
