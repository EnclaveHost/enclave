#!/usr/bin/env bash
# Run the already-built unit-test component exactly as .cargo/config.toml's runner does.
set -u
cd "$(dirname "$0")"
exe=$(grep -o "Executable unittests src/main.rs ([^)]*)" build-tests.out | sed "s/.*(\(.*\))/\1/" | tail -1)
echo "test component: $exe sha256 $(sha256sum < "$exe" | cut -c1-64)"
exec timeout 300 wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup "$exe" --test-threads=1 "$@" 2>&1
