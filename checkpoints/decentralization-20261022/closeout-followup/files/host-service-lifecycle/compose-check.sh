#!/usr/bin/env bash
# Would 6c38c048 compose onto C's newer head 0757085e5? Fetch that commit into MY clone (read-only for C) and run a
# trial merge with `git merge-tree --write-tree` (writes objects only; no ref, index or worktree change).
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-lifecycle/candidate
git fetch -q /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-host-services-compose/candidate 0757085e5b78ed38efc11920fb3cf4a25d7dfc4d
[ "$(git rev-parse FETCH_HEAD)" = 0757085e5b78ed38efc11920fb3cf4a25d7dfc4d ]
set +e; git merge-tree --write-tree --name-only --messages 0757085e5b78ed38efc11920fb3cf4a25d7dfc4d 6c38c0489d769db12e5037e7c20f7372e56d5620; rc=$?; set -e
echo "[compose] merge-tree exit=$rc (0 = clean)"; git rev-parse HEAD; git status --porcelain --untracked-files=no | wc -l
