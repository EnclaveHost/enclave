#!/usr/bin/env bash
# ROOT-AUTHORIZED 1024 MiB Rust job (not run by e49 without authorization). Native host `cargo test` of s3-ipfs-adapter:
#   1. PATCHED tree (car404/tree): the whole existing suite + the 2 new tests -> all must pass;
#   2. MUTANT tree (guard removed, helper kept): only the 2 new tests -> the 404 test must FAIL, the positive one pass.
# Offline, locked, one rustc at a time, own target dir (the canonical work/enclave-apps target is never touched).
set -u
C=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-upload-502-20261021/car404
export CARGO_TARGET_DIR=$C/target CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0
unset ENCLAVE_PORTS
date -u +%FT%TZ
sha256sum $C/tree/s3-ipfs-adapter/src/main.rs $C/tree-mutant/s3-ipfs-adapter/src/main.rs $C/tree/s3-ipfs-adapter/Cargo.lock | cut -c1-16,65-
(cd $C/tree/s3-ipfs-adapter && cargo test --offline --locked -- --test-threads=1 > $C/patched.test.out 2>&1); echo "patched rc=$?"
(cd $C/tree-mutant/s3-ipfs-adapter && cargo test --offline --locked -- --test-threads=1 a_car_of_ > $C/mutant.test.out 2>&1); echo "mutant rc=$? (expected non-zero: the 404 test fails)"
grep -E "^test result|^test .*(ok|FAILED)$" $C/patched.test.out | tail -5; grep -E "^test a_car_of_|^test result" $C/mutant.test.out
date -u +%FT%TZ
