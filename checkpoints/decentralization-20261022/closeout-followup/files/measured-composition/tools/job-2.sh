#!/usr/bin/env bash
# job-2: ONE queued job (512 MiB). (1) control: the untouched candidate's own --check results; (2) tree-a and tree-b by
# tools/run-tree.py with the corrected build order; (3) the C2 relay/CLI/closure suites in tree-b, bash-only (no Python
# resident: job-1 reached 519 MiB with it), then the capture must still be clean.
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition
date -u +%FT%TZ > "$M/rawlogs/job-2.started.utc"
"$M/tools/control-candidate.sh" "$M/tmp/control"; rc0=$?
python3 -u "$M/tools/run-tree.py" "$M/tree-a" a; ra=$?
python3 -u "$M/tools/run-tree.py" "$M/tree-b" b --c2; rb=$?
cd "$M/tree-b"; rt=0
for t in relay-u7-eligible-routing cli-attest-verifier supervisor-image-closure; do
  node --test --test-concurrency=1 "test/$t.test.mjs" > "$M/out/b/t-c2-$t.log" 2>&1; r=$?; echo "[b] t-c2-$t: rc=$r"
  grep -E "^# (tests|pass|fail|skipped|cancelled) " "$M/out/b/t-c2-$t.log"; [ $r -eq 0 ] || { rt=1; grep -E "^not ok|expected|actual" "$M/out/b/t-c2-$t.log" | head -20; }
done
dirty=$(GIT_DIR="$M/tree-b/.git" GIT_WORK_TREE="$M/tree-b" GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all | grep -v "node_modules/" | grep -v " relay/network-runtime.bundle.mjs" | head -5)
[ -z "$dirty" ] && echo "[b] g9-clean-after-c2-suites: OK" || { echo "[b] g9-clean-after-c2-suites: FAIL $dirty"; rt=1; }
date -u +%FT%TZ > "$M/rawlogs/job-2.finished.utc"
echo "JOB-2 rc control=$rc0 a=$ra b=$rb c2suites=$rt"
[ $ra -eq 0 ] && [ $rb -eq 0 ] && [ $rt -eq 0 ]
