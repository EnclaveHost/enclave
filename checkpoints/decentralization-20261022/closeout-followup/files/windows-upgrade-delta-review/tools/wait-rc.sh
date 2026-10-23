#!/bin/bash
# wait-rc.sh NAME : print when rawlogs/NAME starts (queue START line) and when it finishes (rc file)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/windows-upgrade-delta-review || exit 1
started=0
until [ -e "rawlogs/$1.rc" ]; do
  if [ "$started" = 0 ] && grep -q 'START' "rawlogs/$1.out" 2>/dev/null; then echo "$1 started $(date -u +%T)"; started=1; fi
  sleep 5
done
echo "$1 finished rc=$(cat "rawlogs/$1.rc") $(date -u +%T)"
