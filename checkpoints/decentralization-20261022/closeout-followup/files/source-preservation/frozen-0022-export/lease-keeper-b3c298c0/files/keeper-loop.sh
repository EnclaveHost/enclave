#!/bin/bash
# The keeper's finite loop (ROOT starts it, e.g. under systemd-run --user or tmux; nothing installs it). One instance only
# (flock on state/loop.lock). Each cycle runs through the UNCHANGED shared queue at 256 MiB; a queue answer 98 (not started)
# is retried every 15 s only while the lowest known lease (state/last.json) is still valid, at most 40 times. Stops on any
# exit code other than 0/5 (3 reconcile, 4 refused, 10 done), at the cycle's own TTL, or - even if the queue never starts a
# cycle - at the loop's own hard deadline (KEEPER_LOOP_MAX_S, default 4 h 10 min from loop start; exit 11). A cycle every
# ${KEEPER_INTERVAL:-60} s.
set -u
here=$(cd "$(dirname "$0")" && pwd); S=${KEEPER_STATE:-$here/state}
Q=${KEEPER_QUEUE:-"python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $S/queue.guard.log --"}
CYCLE=${KEEPER_CYCLE:-"node $here/keeper-cycle.mjs"}
SLEEP=${KEEPER_SLEEP:-sleep}
mkdir -p "$S" && chmod 700 "$S"
exec 9>"$S/loop.lock"; flock -n 9 || { echo "another keeper loop is running"; exit 6; }
lease_valid() { python3 -c 'import json,sys,time; d=json.load(open(sys.argv[1])); m=d.get("minLeaseUntil"); sys.exit(0 if m is None or m > time.time() else 1)' "$S/last.json" 2>/dev/null || [ ! -e "$S/last.json" ]; }
END=$(( $(date +%s) + ${KEEPER_LOOP_MAX_S:-15000} ))
while :; do
  [ "$(date +%s)" -lt "$END" ] || { echo "keeper loop ends: loop deadline ($(date -u +%FT%TZ))" | tee -a "$S/cycles.err"; exit 11; }
  tries=0
  while :; do
    KEEPER_STATE="$S" $Q $CYCLE >> "$S/cycles.log" 2>> "$S/cycles.err"; rc=$?
    [ $rc = 98 ] || break
    tries=$((tries + 1)); if [ $tries -ge 40 ] || ! lease_valid; then echo "queue never started the cycle ($tries tries)" >> "$S/cycles.err"; rc=5; break; fi
    $SLEEP 15
  done
  case $rc in 0|5) ;; *) echo "keeper loop ends: cycle exit $rc ($(date -u +%FT%TZ))" | tee -a "$S/cycles.err"; exit $rc ;; esac
  $SLEEP "${KEEPER_INTERVAL:-60}"
done
