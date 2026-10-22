#!/bin/bash
# Serial queue: each step waits for capacity (18 GiB) and runs bounded (1024M, no swap, 1 job). One heavy job at a time.
cd "$(dirname "$0")"
step() { # label, cmd...
  local label=$1; shift
  for attempt in 1 2 3 4 5 6; do
    ./when-capacity.sh "$label" "$@"; rc=$?
    [ "$rc" != 98 ] && { echo "QUEUE $label rc=$rc"; return; }
    echo "QUEUE $label waited 20 min without capacity (attempt $attempt)"
  done
  echo "QUEUE $label NEVER RAN (no capacity)"
}
for m in M6_geq_token_accepted M7_no_reballot_stop_instead M8_reread_without_fence_check M9_ready_ignores_supersede M10_mutations_not_fenced_in_mock; do
  step "mut-$m" ./mutants/run-one.sh "$m"
done
step full2 ./cargo-step.sh test -- --test-threads=1
echo QUEUE-DONE
