#!/bin/bash
# derivation-lease-coverage-stage: ONE persistent OFFLINE test+build of the v3 lease-coverage harness. ROOT launches it after review:
#   jobs/q-exit-status.sh claude-lease-v3-native-<n> 1536 unshare -rnm bash derivation-lease-coverage-stage/jobs/build-test.sh
# Inputs pinned: this stage's SHA256SUMS, combined-r1 SHA256SUMS 69160868 (its v2 harness faa14271 is #[path]-included unchanged),
# tarball 9784e20a, Cargo.lock f122da76 (byte-identical after), rustup 1.96.0, -j1 --frozen --offline.
# Dependency reuse, no forked heavy compile: combined-r1's already-built dependency dir (itself r3's, bind-mounted at r3's absolute
# path, so cargo fingerprints match) is copied ONCE into this stage under a SHARED lock on combined-r1's .combined-lock (refused while
# a combined build holds it; ext4 here: cp falls back from reflink to a plain copy, ~2-4 GB). This job then bind-mounts ITS copy over
# r3's path inside its private mount namespace; all writes land in the copy. combined-r1 and r3 on disk are never written.
# Order: (1) verbatim-upstream check (Python, refuses before cargo) (2) cargo test: expects 14 = combined's 9 + v3's 5 (3) build.
set -uo pipefail
export PATH=/home/steven/.cargo/bin:/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/rpc-production-final-20261025
S=$P/derivation-lease-coverage-stage; C=$P/derivation-client-stage/combined-r1
R3B=$P/derivation-client-stage/r3/build/deps-43698236e9186750
CB=$C/build/deps-43698236e9186750
TB=$W/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz
EX=derivation_harness_lease_v3
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## SETUP: $*" | tee -a $OUT/setup.txt; echo "## lease-v3-native rc=9"; exit 9; }
mkdir -p $OUT || exit 9
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rnm"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ "$(sha256sum < $C/SHA256SUMS | cut -c1-64)" = 69160868712324190a95e06cef91dd30526c7afe79896838ca8d1dae2bc32da1 ] || die "combined-r1 SHA256SUMS is not 69160868"
(cd $C && sha256sum -c --quiet SHA256SUMS) || die "combined-r1 != its SHA256SUMS"
[ "$(sha256sum < $TB | cut -c1-64)" = 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 ] || die "tarball is not 9784e20a"
TOP=$(tar -tzf $TB | head -1 | cut -d/ -f1)
[ "$(tar -xzOf $TB "$TOP/Cargo.lock" | sha256sum | cut -c1-64)" = f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f ] || die "lock is not f122da76"
TC=$(RUSTUP_TOOLCHAIN=1.96.0 rustc -V 2>&1); case "$TC" in 'rustc 1.96.0 '*) ;; *) die "toolchain is not 1.96.0: $TC";; esac
python3 -I $S/jobs/check_upstream_copy.py $TB $S/src/zk-utils/examples/$EX.rs > $OUT/upstream-copy.txt 2>&1 || { cat $OUT/upstream-copy.txt; die "the copied upstream code is not verbatim"; }
B=$S/build/deps-43698236e9186750
if [ ! -e $B/.copied ]; then
  [ -d $CB/base ] && [ -d $CB/target ] && [ -e $CB/cargo/.ready ] || die "combined-r1 dependency dir incomplete: $CB"
  exec 7<$CB/.combined-lock; flock -s -n 7 || die "a combined-r1 build holds its lock: copy refused (never copy a dir being written)"
  mkdir -p $S/build && rm -rf $B && cp -a --reflink=auto $CB $B && rm -f $B/.combined-lock && touch $B/.copied || die "copy of combined-r1 deps"
  exec 7<&-
  echo "copied from $CB at $(date -u +%FT%TZ)" > $OUT/copy.txt
fi
exec 8>$B/.lease-v3-lock; flock -n 8 || die "another lease-v3 run holds $B"
mount --bind $B $R3B || die "bind mount (needs unshare -rnm)"                    # private namespace only; r3 on disk unchanged
X=$R3B/base/crates/proof/zk/utils/examples
mkdir -p $X && cp $C/src/zk-utils/examples/derivation_harness_combined.rs $S/src/zk-utils/examples/$EX.rs $X/ || die "examples"
E=(env -i PATH=$PATH HOME=$R3B RUSTUP_HOME=/home/steven/.rustup RUSTUP_TOOLCHAIN=1.96.0 CARGO_HOME=$R3B/cargo CARGO_TARGET_DIR=$R3B/target
   CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true)
rb=-1
(cd $R3B/base && "${E[@]}" timeout 10800 cargo test -p base-proof-zk-utils --example $EX --frozen --offline -j1 -- --test-threads=1) > $OUT/test.txt 2>&1; rt=$?
[ $rt = 0 ] && { (cd $R3B/base && "${E[@]}" timeout 3600 cargo build -p base-proof-zk-utils --example $EX --frozen --offline -j1) > $OUT/build.txt 2>&1; rb=$?; }
(cd $R3B/base && tar -xzOf $TB "$TOP/Cargo.lock" | cmp - Cargo.lock >/dev/null) && echo "Cargo.lock unchanged f122da76" > $OUT/lock.txt || echo "Cargo.lock CHANGED" > $OUT/lock.txt
f=$R3B/target/debug/examples/$EX; [ -x $f ] && sha256sum $f | sed "s#$R3B#<lease-v3 build copy>#" > $OUT/binary.sha256
grep -E '^test |^test result:|^error(\[|:)' $OUT/test.txt > $OUT/test-summary.txt 2>/dev/null
n=$(grep -cE '^test .* \.\.\. ok$' $OUT/test.txt)
echo "## lease-v3-native test=$rt build=$rb tests-ok=$n (expected 14) $(cat $OUT/lock.txt)"; tail -2 $OUT/test-summary.txt 2>/dev/null
[ $rt = 0 ] && [ $rb = 0 ] && [ "$n" = 14 ] && grep -q unchanged $OUT/lock.txt
