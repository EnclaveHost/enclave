#!/usr/bin/env bash
# q.sh <MiB> <name> <command...>: ONE job through work/claude-test-queue.py, retried only while the queue answers 98
# (NOT STARTED). The 256 lane refuses at once while held, so wait 30 s between tries (up to 120 tries) - same cap, no evasion.
set -u
mib="$1"; name="$2"; shift 2
here="$(cd "$(dirname "$0")/.." && pwd)"; mkdir -p "$here/logs"; log="$here/logs/$name.log"; : > "$log"
for i in $(seq 1 120); do
  echo "[q] $(date -Is) try $i cmd: $*" >> "$log"
  python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$here/logs/$name.guard.log" -- "$@" >> "$log" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
  sleep 30
done
echo "[q] $(date -Is) exit=$rc" >> "$log"
echo "$rc" > "$here/logs/$name.rc"
grep -E "^\[queue\] (START|EXIT)" "$log" | tail -3
echo "exit=$rc"; exit $rc
