#!/bin/bash
# derivation-client-stage/combined-r1: ONE persistent OFFLINE build of the combined native harness + witness_fetch (root launches it):
#   jobs/q-exit-status.sh claude-combined-native-<n> 1536 unshare -rnm bash derivation-client-stage/combined-r1/jobs/build-test.sh all|harness|fetch
# Inputs pinned: tarball 9784e20a, Cargo.lock f122da76 (byte-identical after the build), rustup 1.96.0, -j1, --frozen --offline.
# Dependency reuse WITHOUT touching r3: the r3 dependency dir build/deps-43698236e9186750 (source, private CARGO_HOME with git dbs +
# config.json, target) is reflink-copied ONCE into combined-r1/build/ while holding a SHARED read-only lock on r3's .lock (refused if
# r3's own build holds it). Inside this job's private mount namespace the copy is bind-mounted over r3's path, so every absolute path
# (and so every cargo fingerprint) is identical to r3's: compiled dependencies are reused and all writes go to the copy. r3 is never
# written. Nothing is deleted on failure; the copy persists across retries (keyed by tarball + lock + toolchain only).
set -uo pipefail
MODE=${1:-}; case "$MODE" in all|harness|fetch) ;; *) echo "usage: build-test.sh all|harness|fetch"; exit 2;; esac
export PATH=/home/steven/.cargo/bin:/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work; C=$W/rpc-production-final-20261025/derivation-client-stage/combined-r1
R3B=$W/rpc-production-final-20261025/derivation-client-stage/r3/build/deps-43698236e9186750
TB=$W/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz
OUT=$C/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## SETUP: $*" | tee -a $OUT/setup.txt; echo "## combined-native rc=9"; exit 9; }
mkdir -p $OUT || exit 9
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rnm"
(cd $C && sha256sum -c --quiet SHA256SUMS) || die "combined-r1 != SHA256SUMS"
[ "$(sha256sum < $TB | cut -c1-64)" = 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 ] || die "tarball is not 9784e20a"
TOP=$(tar -tzf $TB | head -1 | cut -d/ -f1)
[ "$(tar -xzOf $TB "$TOP/Cargo.lock" | sha256sum | cut -c1-64)" = f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f ] || die "lock is not f122da76"
TC=$(RUSTUP_TOOLCHAIN=1.96.0 rustc -V 2>&1); case "$TC" in 'rustc 1.96.0 '*) ;; *) die "toolchain is not 1.96.0: $TC";; esac
B=$C/build/deps-43698236e9186750
if [ ! -e $B/.copied ]; then
  [ -d $R3B/base ] && [ -e $R3B/cargo/.ready ] && [ -f $R3B/cargo/registry/index/index.crates.io-1949cf8c6b5b557f/config.json ] || die "r3 dependency dir incomplete: $R3B"
  exec 7<$R3B/.lock; flock -s -n 7 || die "r3's build holds its lock: copy refused (never copy a dir being written)"
  rm -rf $B && cp -a --reflink=auto $R3B $B && touch $B/.copied || die "reflink copy of r3 deps"
  exec 7<&-
  echo "copied from $R3B at $(date -u +%FT%TZ)" > $OUT/copy.txt
fi
exec 8>$B/.combined-lock; flock -n 8 || die "another combined run holds $B"
mount --bind $B $R3B || die "bind mount (needs unshare -rnm)"                    # private namespace only; r3 on disk unchanged
X=$R3B/base/crates/proof/zk
mkdir -p $X/utils/examples $X/witness/examples
cp $C/src/zk-utils/examples/derivation_harness_combined.rs $X/utils/examples/ && cp $C/src/zk-witness/examples/witness_fetch.rs $X/witness/examples/ || die "examples"
E=(env -i PATH=$PATH HOME=$R3B RUSTUP_HOME=/home/steven/.rustup RUSTUP_TOOLCHAIN=1.96.0 CARGO_HOME=$R3B/cargo CARGO_TARGET_DIR=$R3B/target
   CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true)
rt=-1; rb=-1; rf=-1
if [ $MODE != fetch ]; then
  (cd $R3B/base && "${E[@]}" timeout 10800 cargo test -p base-proof-zk-utils --example derivation_harness_combined --frozen --offline -j1 -- --test-threads=1) > $OUT/harness-test.txt 2>&1; rt=$?
  [ $rt = 0 ] && { (cd $R3B/base && "${E[@]}" timeout 3600 cargo build -p base-proof-zk-utils --example derivation_harness_combined --frozen --offline -j1) > $OUT/harness-build.txt 2>&1; rb=$?; }
fi
if [ $MODE != harness ] && { [ $MODE = fetch ] || [ $rb = 0 ]; }; then
  (cd $R3B/base && "${E[@]}" timeout 10800 cargo build -p base-proof-zk-witness --example witness_fetch --frozen --offline -j1) > $OUT/fetch-build.txt 2>&1; rf=$?
fi
(cd $R3B/base && tar -xzOf $TB "$TOP/Cargo.lock" | cmp - Cargo.lock >/dev/null) && echo "Cargo.lock unchanged f122da76" > $OUT/lock.txt || echo "Cargo.lock CHANGED" > $OUT/lock.txt
for b in derivation_harness_combined witness_fetch; do f=$R3B/target/debug/examples/$b; [ -x $f ] && sha256sum $f | sed "s#$R3B#<combined-r1 build copy>#" >> $OUT/binaries.sha256; done
grep -E '^test |^test result:|^error(\[|:)' $OUT/harness-test.txt > $OUT/test-summary.txt 2>/dev/null
echo "## combined-native mode=$MODE harness-test=$rt harness-build=$rb fetch-build=$rf"; tail -3 $OUT/test-summary.txt 2>/dev/null
case $MODE in harness) [ $rt = 0 ] && [ $rb = 0 ];; fetch) [ $rf = 0 ];; all) [ $rt = 0 ] && [ $rb = 0 ] && [ $rf = 0 ];; esac
