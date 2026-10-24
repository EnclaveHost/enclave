#!/bin/bash
set -euo pipefail
base=/home/steven/Documents/Codex/2026-10-18/wo
cd "$base/work/custody-operator-funding-options-20261023"
ck="$base/work/source-checkpoint-20261022/main-repo"
for f in lib/protected-inventory.mjs bin/prepare.mjs bin/root-send.mjs test/protected-inventory.test.mjs ROOT-OPERATIONS.md; do
 /home/steven/.local/bin/gitleaks stdin --no-banner --redact --config "$ck/.gitleaks.toml" < "$f"
 python3 "$ck/.githooks/scan-crypto-keys.py" --files "$f"
done
git add -- lib/protected-inventory.mjs bin/prepare.mjs bin/root-send.mjs test/protected-inventory.test.mjs ROOT-OPERATIONS.md
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -m 'Require both protected deployments for new operator maintenance signing' >/dev/null
git rev-parse HEAD
