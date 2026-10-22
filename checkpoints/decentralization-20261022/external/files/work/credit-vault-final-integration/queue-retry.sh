#!/usr/bin/env bash
# queue-retry.sh <mib> <name> -- cmd... : retry the shared queue while it answers 98 (NOT STARTED); output -> logs/<name>.log,
# final exit code -> logs/<name>.rc (written last, so its existence means the job is over). One job at a time per worker.
set -uo pipefail
mib=$1; name=$2; shift 3
d="$(cd "$(dirname "$0")" && pwd)"
rm -f "$d/logs/$name.rc"
for i in $(seq 1 400); do
  python3 "$d/../claude-test-queue.py" --mib "$mib" --log "$d/logs/$name.guard.log" -- "$@" > "$d/logs/$name.log" 2>&1; c=$?
  [ $c -ne 98 ] && { echo "[retry] $name exit=$c after $i attempt(s)" >> "$d/logs/$name.log"; echo $c > "$d/logs/$name.rc"; exit $c; }
  sleep 20
done
echo "[retry] $name never admitted" >> "$d/logs/$name.log"; echo 98 > "$d/logs/$name.rc"; exit 98
