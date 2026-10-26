#!/bin/bash
# derivation-native-config-check-stage: r4's two native config checks, run by ROOT after the combined build has FINISHED:
#   jobs/q-exit-status.sh claude-native-config-check-<n> 1536 unshare -rnm bash derivation-native-config-check-stage/jobs/run-check.sh
# Reuses combined-r1's persistent dependency copy (build/deps-43698236e9186750) through the SAME private-mount-namespace trick: the copy is
# bind-mounted over r3's original path (identical absolute paths -> cargo fingerprints match -> compiled dependencies reused). The
# example is supplied by bind-mounting a PRIVATE examples dir over zk/utils/examples, so NO source file of combined-r1's tree is written
# (only its shared target/ gains this example's artifacts). Refuses while the combined build (its .combined-lock) is running.
# PASS = Cargo.lock f122da76 byte-identical BEFORE and AFTER, both test names "... ok", and EXACTLY
#   "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"   (never a filtered/zero-test success)
set -uo pipefail
export PATH=/home/steven/.cargo/bin:/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work; S=$W/rpc-production-final-20261025/derivation-native-config-check-stage
CB=$W/rpc-production-final-20261025/derivation-client-stage/combined-r1/build/deps-43698236e9186750
R3B=$W/rpc-production-final-20261025/derivation-client-stage/r3/build/deps-43698236e9186750
TB=$W/resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz
LOCK=f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PW=""
die() { echo "## SETUP: $*" | tee -a $OUT/setup.txt; echo "## native-config-check rc=9"; exit 9; }
mkdir -p $OUT || exit 9
trap '[ -n "$PW" ] && rm -rf -- "$PW"' EXIT
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rnm"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ "$(sha256sum < $TB | cut -c1-64)" = 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 ] || die "tarball is not 9784e20a"
TC=$(RUSTUP_TOOLCHAIN=1.96.0 rustc -V 2>&1); case "$TC" in 'rustc 1.96.0 '*) ;; *) die "toolchain is not 1.96.0: $TC";; esac
[ -e $CB/.copied ] && [ -d $CB/base/crates/proof/zk/utils/examples ] || die "combined-r1 dependency copy missing or incomplete: run the combined build first"
exec 9<$CB/.combined-lock; flock -x -n 9 || die "the combined build is still running (its lock is held)"
[ "$(sha256sum < $CB/base/Cargo.lock | cut -c1-64)" = $LOCK ] || die "Cargo.lock BEFORE is not f122da76"
PW=$(mktemp -d /tmp/native-config.XXXXXXXX) && mkdir $PW/examples && cp $S/src/examples/native_config_check.rs $PW/examples/ || die "private examples"
mount --bind $CB $R3B && mount --bind $PW/examples $R3B/base/crates/proof/zk/utils/examples || die "bind mounts (needs unshare -rnm)"
E=(env -i PATH=$PATH HOME=$R3B RUSTUP_HOME=/home/steven/.rustup RUSTUP_TOOLCHAIN=1.96.0 CARGO_HOME=$R3B/cargo CARGO_TARGET_DIR=$R3B/target
   CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_BUILD_JOBS=1 CARGO_NET_OFFLINE=true)
(cd $R3B/base && "${E[@]}" timeout 5400 cargo test -p base-proof-zk-utils --example native_config_check --frozen --offline -j1 -- --test-threads=1) > $OUT/cargo-test.txt 2>&1; rt=$?
AFTER=$(sha256sum < $R3B/base/Cargo.lock | cut -c1-64); echo "Cargo.lock before $LOCK after $AFTER" > $OUT/lock.txt
grep -E '^test |^test result:|^error(\[|:)' $OUT/cargo-test.txt > $OUT/test-summary.txt
ok=1
[ $rt = 0 ] || ok=0
[ "$AFTER" = $LOCK ] || ok=0
grep -qx 'test tests::compiled_mainnet_config_hash_is_the_source_pin ... ok' $OUT/cargo-test.txt || ok=0
grep -qx 'test tests::bridge_schedule_keys_are_the_upstream_serde_keys_in_contract_order ... ok' $OUT/cargo-test.txt || ok=0
[ "$(grep -c '^test result:' $OUT/cargo-test.txt)" = 1 ] || ok=0
grep -qx 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in .*' $OUT/cargo-test.txt \
  || grep -qx 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out' $OUT/cargo-test.txt || ok=0
echo "## native-config-check test-rc=$rt lock-after=$AFTER exact2=$ok"; cat $OUT/test-summary.txt
[ $ok = 1 ] && echo "PASS native-config-check 2/2 lock $LOCK" | tee $OUT/RESULT && exit 0 || exit 1
