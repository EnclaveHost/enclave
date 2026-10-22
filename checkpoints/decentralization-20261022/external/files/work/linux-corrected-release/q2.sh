#!/usr/bin/env bash
# q2.sh <MiB> <name> <command...>: q.sh with patience - ONE job through work/claude-test-queue.py, retried only while
# the queue answers 98 (NOT STARTED), up to 90 tries (the queue itself waits ~60 s per try). Fresh logs/<name>.log.
set -u
mib="$1"; name="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$here/logs"; log="$here/logs/$name.log"; : > "$log"
for i in $(seq 1 90); do
  echo "[q] $(date -Is) try $i cmd: $*" >> "$log"
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$here/logs/$name.guard.log" -- "$@" >> "$log" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
done
echo "[q] $(date -Is) exit=$rc" >> "$log"
grep -E "^\[queue\] (START|EXIT)|^(ok|FAIL|PASS|---) |^--- FAIL|^run-.*PASS" "$log" | tail -30
echo "exit=$rc"; exit $rc
