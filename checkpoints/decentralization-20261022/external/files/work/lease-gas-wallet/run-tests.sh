#!/usr/bin/env bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
for attempt in 1 2 3 4; do
  python3 work/claude-test-queue.py --mib 512 --log /home/steven/Documents/Codex/2026-10-18/wo/work/lease-gas-wallet/combined.guard.log -- node --test --test-concurrency=1 work/lease-gas-wallet/request.test.mjs work/lease-gas-wallet/verify-reserve.test.mjs work/lease-gas-wallet/handoff-server.test.mjs > work/lease-gas-wallet/combined-test.log 2>&1
  rc=$?
  if [ "$rc" -ne 98 ]; then break; fi
  sleep 10
done
printf 'exit=%s attempts=%s\n' "$rc" "$attempt" > work/lease-gas-wallet/combined.done
exit "$rc"
