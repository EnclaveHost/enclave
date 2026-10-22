#!/usr/bin/env bash
# Mutant = the fix with the wait-first branch disabled (stale served at once, refresh behind:
# the published 0.1.3 behavior). Build (final crate only; deps reused) then run the 8 stale tests.
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/mutant/enclavedns
export CARGO_TARGET_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/target CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0
out=$(cargo test --target wasm32-wasip2 --offline -j1 --no-run 2>&1); echo "$out" | tail -3
exe=$(echo "$out" | grep -o "Executable unittests src/main.rs ([^)]*)" | sed "s/.*(\(.*\))/\1/")
for t in expired_entry_and_healthy concurrent_queries fresh_nxdomain fresh_bogus ttl_zero cancelled_waiter slow_upstream unavailable_upstream; do
  timeout 120 wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup "$exe" --test-threads=1 resolver::tests::$t 2>&1 | grep -E "^test |panicked|left:|right:|test result" | head -6
done
