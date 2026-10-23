#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
git add -A
git -c user.name=SteveDeFacto -c user.email=5148995+SteveDeFacto@users.noreply.github.com commit -q -m "metal0 control: image-only activation adaptation for the restored custody vaults (a6b1378c, ee5df6b8)

Adapted from the reviewed Oct-21 post-adoption activation to ONLY config.json dist: protected-field preconditions on root's
21:13Z baseline (config 58aa9653, leaseGas 3570d2, WorkingDirectory metal-deabf8f90, KillMode control-group, both drop-ins,
the two baseline guests), additive relay admission (35 + candidate, CAS with backup and restore-on-failure), fresh lease
preflight on production-equal modules, restart/attach/adoption, the reviewed gate v4 byte copy, no extra renewal wait,
safe rollback. Focused stub tests 16/16, safety mutants 11/11 killed. Source only; root executes each phase after review."
git log -1 --format='%H %T %an <%ae> %cI'
git show --stat --format= HEAD | tail -1
[ -z "$(git status --porcelain)" ]
