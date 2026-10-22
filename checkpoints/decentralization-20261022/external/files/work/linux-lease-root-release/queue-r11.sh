#!/bin/sh
cd /home/steven/Documents/Codex/2026-10-18/wo || exit 1
attempt=1
while [ "$attempt" -le 24 ]; do
  python3 work/claude-test-queue.py --mib 768 --log /home/steven/Documents/Codex/2026-10-18/wo/work/linux-lease-root-release/build-r11-$attempt.guard.json -- sh work/linux-lease-root-release/resume-after-r10.sh
  result=$?
  if [ "$result" -ne 98 ]; then exit "$result"; fi
  attempt=$((attempt + 1))
  sleep 10
done
exit 98
