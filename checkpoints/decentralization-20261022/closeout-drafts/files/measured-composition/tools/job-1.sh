#!/usr/bin/env bash
# job-1: ONE queued job (512 MiB). tree-a (C1/C3/C4 + cost + B1, no C2) then tree-b (the same + the C2 proposal), each by
# tools/run-tree.py (builds with the tree's own builders, --check, provenance pins, deterministic scratch capture, focused tests).
set -uo pipefail
M=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition
date -u +%FT%TZ > "$M/rawlogs/job-1.started.utc"
python3 -u "$M/tools/run-tree.py" "$M/tree-a" a; ra=$?
python3 -u "$M/tools/run-tree.py" "$M/tree-b" b --c2; rb=$?
date -u +%FT%TZ > "$M/rawlogs/job-1.finished.utc"
echo "JOB-1 rc a=$ra b=$rb"
[ $ra -eq 0 ] && [ $rb -eq 0 ]
