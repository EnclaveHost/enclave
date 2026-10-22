#!/usr/bin/env bash
# RE-RUN after the first authorized job (logs/cargo-test.*): ONLY the necessary checks, one queue job at 1024.
#   1. PATCHED tree: the whole suite again (main.rs changed: test harness only) -> all must pass.
#   2. MUTANT (guard removed) in its OWN target dir (a copy, deps reused) with main.rs touched, so cargo cannot reuse the
#      patched binary as the first run did -> the 404 test must FAIL, the positive one pass. Both binaries are hashed.
set -u
C=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/car404
export CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
unset ENCLAVE_PORTS
date -u +%FT%TZ
sha256sum $C/tree/s3-ipfs-adapter/src/main.rs $C/tree-mutant/s3-ipfs-adapter/src/main.rs $C/tree/s3-ipfs-adapter/Cargo.lock | cut -c1-16,65-
(cd $C/tree/s3-ipfs-adapter && CARGO_TARGET_DIR=$C/target cargo test --offline --locked -- --test-threads=1 > $C/patched3.test.out 2>&1); echo "patched rc=$?"
rm -rf $C/target-mutant && cp -a $C/target $C/target-mutant && touch $C/tree-mutant/s3-ipfs-adapter/src/main.rs
(cd $C/tree-mutant/s3-ipfs-adapter && CARGO_TARGET_DIR=$C/target-mutant cargo test --offline --locked -- --test-threads=1 a_car_of_ > $C/mutant3.test.out 2>&1); echo "mutant rc=$? (expected non-zero: the 404 test fails)"
for f in $C/patched3.test.out $C/mutant3.test.out; do b=$(grep -o 'Running unittests src/main.rs ([^)]*)' $f | sed 's/.*(\(.*\))/\1/'); echo "$(basename $f): $(grep -c '^ *Compiling s3-ipfs-adapter' $f) crate compile(s); binary $b $(sha256sum $b | cut -c1-16)"; done
grep -E "^test result" $C/patched3.test.out; grep -E "^test a_car_of_|^test result" $C/mutant3.test.out
date -u +%FT%TZ
