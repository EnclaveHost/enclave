#!/usr/bin/env bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
for attempt in $(seq 1 90); do
  python3 work/claude-test-queue.py --mib 256 --log /home/steven/Documents/Codex/2026-10-18/wo/work/site-host-live-publish/root-preflight-final.guard.log -- node work/site-host-live-publish/root-preflight.mjs
  rc=$?
  if [ "$rc" -ne 98 ]; then exit "$rc"; fi
  sleep 20
done
exit 98
