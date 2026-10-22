#!/usr/bin/env bash
# One test/build job of this candidate through the coordinator's shared queue (work/claude-test-queue.py): exclusive
# allocation, systemd scope MemoryMax=512M MemorySwapMax=0, memory-guard tree cap 512 MiB, host floor 16 GiB. The queue
# waits at most 60 s for the allocation; exit 98 = NOT STARTED (a queue wait, not a test result).
#   usage: run-guarded.sh <log-file> <command...>
set -u
log="$1"; shift
echo "[run-guarded] $(date -Is) cmd: $*" >> "$log"
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log "$log.guard" -- "$@" >> "$log" 2>&1
rc=$?
echo "[run-guarded] $(date -Is) exit=$rc" >> "$log"
exit $rc
