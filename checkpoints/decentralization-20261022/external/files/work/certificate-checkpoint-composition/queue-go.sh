#!/bin/bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
for attempt in $(seq 1 12); do
  python3 work/claude-test-queue.py --mib 1024 --log /home/steven/Documents/Codex/2026-10-18/wo/work/certificate-checkpoint-composition/go-r2.guard.log -- bash work/certificate-checkpoint-composition/run-go.sh >> work/certificate-checkpoint-composition/go-r2.out 2>&1
  result=$?
  if [ "$result" -ne 98 ]; then
    printf 'exit=%s attempts=%s\n' "$result" "$attempt" > work/certificate-checkpoint-composition/go-r2.done
    exit "$result"
  fi
  sleep 15
done
printf 'exit=98 attempts=12 NOT STARTED\n' > work/certificate-checkpoint-composition/go-r2.done
exit 98
