#!/usr/bin/env bash
# queue-retry.sh <mib> <name> -- cmd...   : retry the shared queue while it answers 98 (NOT STARTED); output -> logs/<name>.log
set -uo pipefail
mib=$1; name=$2; shift 3
d="$(cd "$(dirname "$0")" && pwd)"
for i in $(seq 1 240); do
  python3 "$d/../claude-test-queue.py" --mib "$mib" --log "$d/logs/$name.guard.log" -- "$@" > "$d/logs/$name.log" 2>&1; c=$?
  [ $c -ne 98 ] && { echo "[retry] $name exit=$c after $i attempt(s)" >> "$d/logs/$name.log"; exit $c; }
  sleep 20
done
echo "[retry] $name never admitted" >> "$d/logs/$name.log"; exit 98
