#!/usr/bin/env bash
# One queued Rust job (1024 MiB), offline, -j1: native unit tests of the startup fix (whole crate), a MUTATION control
# (the guard reverted: the new unit test must fail), then the release wasm32-wasip2 build of the fixed crate.
set -uo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target"
( cd ipns-publisher && cargo test --offline -j1 2>&1 | grep -E "^test |test result|panicked|FAILED|^error|^warning: unused" | tail -120 ); t=${PIPESTATUS[0]}
rm -rf mutant && mkdir mutant && cp -r ipns-publisher mutant/ && \
  python3 - <<'PY'
p='mutant/ipns-publisher/src/main.rs'; s=open(p).read()
a='''    if answered {
        return Ok(0); // a verified fresh name
    }'''
assert s.count(a)==1; s=s.replace(a,'''    if answered || true {
        return Ok(0); // MUTANT: the guard reverted (the deployed behaviour)
    }''')
open(p,'w').write(s)
PY
( cd mutant/ipns-publisher && cargo test --offline -j1 startup_tests 2>&1 | grep -E "^test |test result" ); m=${PIPESTATUS[0]}
( cd ipns-publisher && cargo build --offline -j1 --release --target wasm32-wasip2 2>&1 | tail -4 ); b=${PIPESTATUS[0]}
sha256sum target/wasm32-wasip2/release/ipns-publisher.wasm 2>/dev/null
echo "test-rc=$t mutant-rc=$m (must be non-zero) build-rc=$b"
[ $t -eq 0 ] && [ $m -ne 0 ] && [ $b -eq 0 ]
