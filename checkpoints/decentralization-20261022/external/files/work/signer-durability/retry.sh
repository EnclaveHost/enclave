#!/usr/bin/env bash
# retry.sh <step-name>: run one final-runs.sh step, retrying while the shared queue answers 98 (NOT STARTED), bounded.
here="$(cd "$(dirname "$0")" && pwd)"
for i in $(seq 1 8); do "$here/final-runs.sh" "^$1\$" >/dev/null; tail -1 "$here/logs/final-summary.txt" | grep -q "^$1: exit" && break; done
tail -1 "$here/logs/final-summary.txt"
