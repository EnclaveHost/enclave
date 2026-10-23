#!/usr/bin/env bash
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023
ID=(-c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com)
cd "$H/candidate"; [ "$(git rev-parse HEAD)" = 548bf59846621065878c4de6ca12462be5980b42 ]
commit() { local msg=$1; shift; git add -- "$@"; local want; want=$(printf '%s\n' "$@" | sort | tr '\n' ' ')
  [ "$(git diff --cached --name-only | sort | tr '\n' ' ')" = "$want" ] || { echo "staged set mismatch"; git diff --cached --name-only; exit 4; }
  git "${ID[@]}" commit -q -F "$msg"; git log -1 --format='%H %an <%ae> / %cn <%ce> %s'; }
commit "$H/msgs/c4.txt" network/verified-chain.mjs windows/node/host-admission.bundle.mjs metal/guest/host-policy.bundle.mjs test/verified-chain-optin-boundary.test.mjs
commit "$H/msgs/c5.txt" test/helpers/safe-passkey-code.mjs test/fixtures/base-code/safe-passkey-code-base.json test/fixtures/base-code/PROVENANCE.txt \
  scripts/test-fixtures/snapshot-safe-passkey-code.mjs test/site-independent-management.test.mjs test/windows-release-journal.test.mjs \
  test/windows-node-lease-readiness.test.mjs test/windows-shield-startup.test.mjs test/service-index.test.mjs
[ -z "$(git status --porcelain --untracked-files=no)" ]; git status --porcelain | grep -v "^?? network/host-services/packages/" || true
[ "$(git rev-parse HEAD:network/verified-chain.mjs)" = "$(git rev-parse refs/in/a:network/verified-chain.mjs)" ] && echo "verified-chain == A 554a251c"
echo "[commit] ok $(git rev-parse HEAD) tree $(git rev-parse HEAD^{tree})"
