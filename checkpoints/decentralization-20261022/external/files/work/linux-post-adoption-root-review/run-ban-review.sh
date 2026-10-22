#!/usr/bin/env bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
for n in $(seq 1 12); do
  python3 work/claude-test-queue.py --mib 768 --log "/home/steven/Documents/Codex/2026-10-18/wo/work/linux-post-adoption-root-review/ban-before-ledger-$n.guard.log" -- node --test --test-name-pattern='root: explicit ban' work/linux-post-adoption-root-review/ban-before-ledger.test.mjs > "work/linux-post-adoption-root-review/ban-before-ledger-$n.out" 2>&1
  code=$?
  printf 'attempt=%s exit=%s\n' "$n" "$code"
  if [ "$code" -ne 98 ]; then exit "$code"; fi
  sleep 15
done
exit 98
