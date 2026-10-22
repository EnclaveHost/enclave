#!/usr/bin/env bash
# Composed release (queue 1024, offline, -j1): the WHOLE native suite incl. e49's walk over the real 487-block export,
# a MUTATION control of the new DHT rule (an empty walk counted as an answer: the new test must fail), the release wasm.
set -uo pipefail
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="$PWD/target"
export SITE_BLOCKS=/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/content/export/ipfs
export SITE_ROOT=bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou
( cd ipns-publisher && cargo test --offline -j1 2>&1 | grep -E "^test |test result|panicked|FAILED|^error|SITE_BLOCKS|^warning" | tail -150 ); t=${PIPESTATUS[0]}
rm -rf mutant && mkdir mutant && cp -r ipns-publisher mutant/ && python3 - <<'PY'
p='mutant/ipns-publisher/src/main.rs'; s=open(p).read()
a='''fn dht_walk_answers(found: &Option<(u64, Vec<u8>)>) -> bool {
    found.is_some()
}'''
assert s.count(a)==1; s=s.replace(a,'''fn dht_walk_answers(_found: &Option<(u64, Vec<u8>)>) -> bool {
    true // MUTANT: an empty walk counted as a fresh name (d39bf469's behaviour)
}''')
open(p,'w').write(s)
PY
( cd mutant/ipns-publisher && cargo test --offline -j1 startup_tests 2>&1 | grep -E "^test |test result" ); m=${PIPESTATUS[0]}
( cd ipns-publisher && cargo build --offline -j1 --release --target wasm32-wasip2 2>&1 | tail -3 ); b=${PIPESTATUS[0]}
cp target/wasm32-wasip2/release/ipns-publisher.wasm ipns-publisher-ensrepair.wasm 2>/dev/null; sha256sum ipns-publisher-ensrepair.wasm
echo "test-rc=$t mutant-rc=$m (must be non-zero) build-rc=$b"
[ $t -eq 0 ] && [ $m -ne 0 ] && [ $b -eq 0 ]
