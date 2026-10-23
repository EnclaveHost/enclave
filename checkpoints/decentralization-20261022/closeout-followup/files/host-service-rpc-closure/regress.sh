#!/usr/bin/env bash
# Regression of every existing suite that imports a composed module: candidate first; each FAILING file is then run on the
# exact 4106c311 tree (base worktree) to classify it as pre-existing (fails there too) or introduced (passes there).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/host-service-rpc-closure; cd "$H"
N=${RUN_NAME:-run}; C="$H/logs/$N-cand.out"; BO="$H/logs/$N-base.out"
echo "=== candidate: $*"; JOB_SEC=${JOB_SEC:-560} ./job.sh "$@" > "$C" 2>&1; a=$?
grep -E "^ℹ (tests|pass|fail|skipped|cancelled)|^﹣ " "$C"
fails=$(grep -oE "^test at test/[a-z0-9.-]+\.test\.mjs" "$C" | sed 's/^test at //' | sort -u)
grep -E "^test at |^✖ " "$C" | grep -v "failing tests" | head -40
if [ -n "$fails" ]; then
  for f in $fails; do [ -e "base/$f" ] || cp "candidate/$f" "base/$f"; done
  echo "=== base 4106c311 (classification): $fails"; TREE="$H/base" JOB_SEC=${JOB_SEC:-560} ./job.sh $fails > "$BO" 2>&1
  grep -E "^ℹ (tests|pass|fail|skipped|cancelled)" "$BO"; grep -E "^test at |^✖ " "$BO" | grep -v "failing tests" | head -40
fi
echo "[regress] candidate exit=$a"
