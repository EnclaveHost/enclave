#!/usr/bin/env bash
# j5: commit (the repo's .githooks/pre-commit crypto-key scan runs here, inside the queue)
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-memory-accounting-20261023
cd $W/repo
git add docs/operations/host-ram-budget.md test/windows-node-preclaim.test.mjs test/windows-node-scan-slot.test.mjs \
  windows/installer/install-host.ps1 windows/node/agent.mjs windows/node/chain.mjs windows/node/host.mjs \
  windows/vbslike/manager/server.mjs test/windows-hv-memory-accounting.test.mjs test/windows-installer-app-ram.test.mjs
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F $W/commit-msg.txt
git log -1 --format='%H %an <%ae> | %cn <%ce>'
git status --short | grep -v node_modules || true
