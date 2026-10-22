#!/usr/bin/env bash
cd "$(dirname "$0")"
exe=$(grep -o "Executable unittests src/main.rs ([^)]*)" mutant-tests.out | sed "s/.*(\(.*\))/\1/")
echo "mutant component sha256 $(sha256sum < "$exe" | cut -c1-64)"
for t in expired_entry_and_healthy fresh_bogus; do
timeout 120 wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup "$exe" --test-threads=1 --nocapture resolver::tests::$t 2>&1 | grep -E "panicked|assert|left|right|^test |wasm trap" | head -8
done
