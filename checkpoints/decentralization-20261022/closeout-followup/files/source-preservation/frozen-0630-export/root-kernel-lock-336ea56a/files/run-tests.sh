#!/bin/bash
set -u
ROOT=work/resume-after-checkpoint-20261022/root-rpc-kernel-lock
for attempt in $(seq 1 12); do
  python3 work/claude-test-queue.py --mib 256 --log "$ROOT/tests-$attempt.guard.log" -- node --test --test-concurrency=1 "$ROOT/test/runtime-lock.test.mjs" > "$ROOT/tests-$attempt.out" 2>&1
  rc=$?
  if [ "$rc" -ne 98 ]; then printf '%s\n' "$rc" > "$ROOT/tests.rc"; cat "$ROOT/tests-$attempt.out"; exit "$rc"; fi
  sleep 10
done
printf '98\n' > "$ROOT/tests.rc"
exit 98
