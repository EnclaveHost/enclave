#!/usr/bin/env bash
# q.sh <MiB> <name> <command...>: ONE job through work/claude-test-queue.py, retried only while it answers 98 (NOT STARTED),
# 30 s between tries (same cap, no evasion). The command runs offline (offline.sh) with the ssh/scp/sftp denial stubs first.
set -u
mib="$1"; name="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"; log="$here/logs/$name.log"
[ -e "$log" ] && { echo "log $log exists: use a new unique name" >&2; exit 2; }
: > "$log"
for i in $(seq 1 120); do
  echo "[q] $(date -Is) try $i cmd: $*" >> "$log"
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$here/logs/$name.guard.log" -- "$here/offline.sh" "$@" >> "$log" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
  sleep 30
done
echo "[q] $(date -Is) exit=$rc" >> "$log"
echo "$rc" > "$here/logs/$name.rc"
grep -E "^\[queue\] (START|EXIT)" "$log" | tail -3
echo "exit=$rc"; exit $rc
