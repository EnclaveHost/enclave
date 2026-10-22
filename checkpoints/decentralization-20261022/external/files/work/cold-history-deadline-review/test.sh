#!/usr/bin/env bash
set -euo pipefail
review=/home/steven/Documents/Codex/2026-10-18/wo/work/cold-history-deadline-review
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-front-cold-history/tree/isolation/m2
export GOMAXPROCS=2
set +e
go test -p 1 -count=1 -overlay "$review/baseline-overlay.json" -run '^TestFinalizedHistoryProgressSurvivesLaterRangeDeadline$' -v ./bootstrap > "$review/baseline.log" 2>&1
code=$?
set -e
if [ "$code" -eq 0 ] || ! rg -q 'lost completed finalized history at later deadline' "$review/baseline.log"; then
  cat "$review/baseline.log"
  echo 'Baseline did not reproduce the expected failure.'
  exit 1
fi
go test -p 1 -count=1 -overlay "$review/candidate-overlay.json" -run '^TestFinalizedHistoryProgressSurvivesLaterRangeDeadline$' -v ./bootstrap > "$review/candidate.log" 2>&1
cat "$review/candidate.log"
