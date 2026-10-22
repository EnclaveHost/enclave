#!/bin/bash
# The single observation driver: +2/+5/+10 min after the 20:11:17Z activation. Each sample takes the queue (256) on its own,
# so the queue is released between samples. Waits use sleeps of <=50 s. Exit 98 (not started) is retried.
set -u
cd "$(dirname "$0")"
Q=/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py
for spec in plus2:2026-10-21T20:13:17Z plus5:2026-10-21T20:16:17Z plus10:2026-10-21T20:21:17Z; do
  ph=${spec%%:*}; t=$(date -u -d "${spec#*:}" +%s)
  while [ "$(date -u +%s)" -lt "$t" ]; do s=$(( t - $(date -u +%s) )); [ $s -gt 50 ] && s=50; [ $s -gt 0 ] && sleep $s; done
  for try in 1 2 3 4 5; do
    echo "$(date -u +%FT%TZ) $ph start try=$try"
    python3 "$Q" --mib 256 --log "$PWD/$ph.guard.log" -- bash "$PWD/sample.sh" "$ph"; rc=$?
    echo "$(date -u +%FT%TZ) $ph queue_rc=$rc"
    [ $rc -ne 98 ] && break
    sleep 20
  done
done
echo "$(date -u +%FT%TZ) done"
