#!/usr/bin/env bash
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-feature-gap-repair-20261023
cd "$H/candidate"; [ "$(git rev-parse HEAD)" = dda47a35008e989cc6e62c1a79f0fefde49b29f5 ]
F="test/registry-reconcile.test.mjs test/catalog-platform-enforcement.test.mjs test/site-independent-account-startup.test.mjs"
git add $F; [ "$(git diff --cached --name-only | sort | tr '\n' ' ')" = "$(printf '%s\n' $F | sort | tr '\n' ' ')" ]
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -F "$H/msgs/c1.txt"
git log -1 --format='%H %an <%ae> / %cn <%ce> %s'; echo "tree $(git rev-parse HEAD^{tree})"
[ -z "$(git status --porcelain --untracked-files=no)" ]
git format-patch -1 --stdout HEAD > "$H/feature-gap-repair.patch"; sha256sum "$H/feature-gap-repair.patch"
git diff --stat HEAD~1 HEAD
