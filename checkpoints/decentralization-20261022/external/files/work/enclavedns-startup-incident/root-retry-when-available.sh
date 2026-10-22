#!/usr/bin/env bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
for attempt in $(seq 1 12); do
 python3 work/claude-test-queue.py --mib 512 --log /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-startup-incident/root-retry.guard.log -- python3 work/enclavedns-startup-incident/root-retry.py
 rc=$?
 if [ "$rc" -ne 98 ]; then exit "$rc"; fi
 sleep 5
done
exit 98
