#!/usr/bin/env bash
# commit (the repo's .githooks/pre-commit crypto-key scan runs here, inside the queue)
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023/repo
git add network/privacy-agent.mjs network/entries/privacy-agent.mjs test/privacy-agent-startup-cancel.test.mjs
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F ../commit-msg.txt
git log -1 --format='%H %T %an <%ae> | %cn <%ce>'
git status --porcelain --untracked-files=no
