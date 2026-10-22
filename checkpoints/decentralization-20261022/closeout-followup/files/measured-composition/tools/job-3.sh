#!/usr/bin/env bash
# job-3: ONE queued job (512 MiB). (1) the Dockerfile closure listing for tree-a and tree-b; (2) the closure test on tree-a as
# the control for tree-b's failure; (3) the B1 input manifests (overlay selection dry run over the read-only production base).
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition; rc=0
for t in a b; do node "$M/tools/dockerfile-closure.mjs" "$M/tree-$t" | tee "$M/out/$t/dockerfile-closure.json" || rc=1; done
(cd "$M/tree-a" && node --test --test-concurrency=1 test/supervisor-image-closure.test.mjs > "$M/out/a/t-control-supervisor-image-closure.log" 2>&1); echo "[a] control supervisor-image-closure rc=$? (a failure here = pre-existing)"
grep -E "^# (pass|fail) |image omits" "$M/out/a/t-control-supervisor-image-closure.log"
for t in b a; do python3 -u "$M/tools/input-manifest.py" "$M/tree-$t" "$M/out/$t/INPUT-MANIFEST.json" || rc=1; done
for t in a b; do s=$(GIT_DIR="$M/tree-$t/.git" GIT_WORK_TREE="$M/tree-$t" GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v "node_modules/" | grep -v " relay/network-runtime.bundle.mjs" | head -3); [ -z "$s" ] && echo "[$t] clean" || { echo "[$t] DIRTY $s"; rc=1; }; done
echo "JOB-3 rc=$rc"; exit $rc
