#!/bin/bash
# emits each finished package line of a suite log, then the exit line
L=$1; seen=0
while true; do
  n=$(grep -cE '^(ok|FAIL)[[:space:]]' "$L")
  if [ "$n" -gt "$seen" ]; then grep -E '^(ok|FAIL)[[:space:]]' "$L" | tail -n $((n-seen)); seen=$n; fi
  if grep -qE '^exit=|WATCHDOG' "$L"; then grep -E '^exit=|WATCHDOG|peak_bytes|oom' "$L"; exit 0; fi
  sleep 10
done
