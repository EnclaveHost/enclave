#!/usr/bin/env bash
# Root-approved bounded 1024 incremental WASM test job (deps reused, final crate only, -j1, offline).
# 1) CONTROL: old b09130c7 resolver + the reviewer's two counterexamples -> both expected to FAIL.
# 2) FIXED: tree-r2 (R1+R2) -> all 45 expected to pass.
set -u
export CARGO_TARGET_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/target CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0
W="wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup"
build() { cd $1 && touch src/resolver.rs && out=$(cargo test --target wasm32-wasip2 --offline -j1 --no-run 2>&1) || { echo "$out"; exit 1; }
  echo "$out" | grep -E '^(warning|error)' -A5; echo "$out" | grep Finished
  exe=$(echo "$out" | grep -o "Executable unittests src/main.rs ([^)]*)" | sed "s/.*(\(.*\))/\1/"); echo "src resolver.rs $(sha256sum < src/resolver.rs | cut -c1-64)"; echo "component $(sha256sum < $exe | cut -c1-64)"; }
echo "=== CONTROL (old code b09130c7 + counterexamples)"
build /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/control-r2/enclavedns
for t in slow_bogus_refresh_does_not_keep_old_data_alive expired_cname_chain_waits_once_per_request; do
  timeout --foreground 120 $W "$exe" --test-threads=1 --nocapture --exact resolver::tests::$t 2>&1 | grep -E "^test |panicked|assertion|left:|right:|test result|running"; echo "control $t exit=${PIPESTATUS[0]}"
done
echo "=== FIXED (tree-r2)"
build /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/tree-r2/enclavedns
timeout --foreground 300 $W "$exe" --test-threads=1 2>&1; echo "fixed suite exit=$?"
