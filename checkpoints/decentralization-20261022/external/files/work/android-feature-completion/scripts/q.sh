#!/bin/bash
# q.sh <mib> <job-name> -- command...: one job through the shared queue, retried while it reports 98 (not started).
# Writes logs/<job>.out (the command's output), logs/<job>.guard.log (the queue's line), logs/<job>.rc (the exit code).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
MIB=$1; J=$2; shift 2; [ "$1" = "--" ] && shift
rm -f $H/logs/$J.rc
for i in $(seq 1 240); do
  python3 $Q --mib $MIB --log $H/logs/$J.guard.log -- "$@" > $H/logs/$J.out 2>&1; rc=$?
  [ $rc -ne 98 ] && break
  sleep 30
done
echo $rc > $H/logs/$J.rc
