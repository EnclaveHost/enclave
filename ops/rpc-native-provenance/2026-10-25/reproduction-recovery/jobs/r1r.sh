#!/usr/bin/env bash
# R1-RESUME (root-launched, foreground). The first R1 attempt died with its CLI session at ~17:16Z during build A
# (logs/r1.out, logs/r1-build-a.out; no .rc). This job:
#  1. verifies the interrupted, isolated build A (r1/work-a, r1/cargo-home-a) against a FRESH export made with build-binaries.sh's own
#     commands (sources byte-identical, cache copy == the original manifest apart from cargo's own lock/state files);
#  2. RESUMES A in place with build-binaries.sh's exact release environment (labelled "A-resumed": its earlier compiled units are reused);
#  3. builds B entirely FRESH through build-binaries.sh (new work dir and cache copy);
#  4. compares A-resumed, B and the pin 9ca75047; re-verifies every original input unchanged.
# VERIFY_ONLY=1 stops after step 1 (no compilation). Nothing is deleted; new logs only (logs/r1r-*).
set -uo pipefail
. "$(dirname "$0")/inputs.sh"; rc=0
P=9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3; CH0=95d7ca2220f90c7d70dc8a80d18d13ee498249134850fcbee1474f33ee9c5ceb
WA=$R/r1/work-a; HA=$R/r1/cargo-home-a; WB=$R/r1/work-b; HB=$R/r1/cargo-home-b; V=$R/r1/verify-export-$(date -u +%Y%m%dT%H%M%SZ)
offline; toolchain
echo "== 0 original inputs"
need "build-binaries.sh d5bb17e8" [ "$(sha256sum < $SCRIPT | cut -c1-8)" = d5bb17e8 ]
need "base tarball 9784e20a" [ "$(sha256sum < $TAR | cut -c1-64)" = 9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 ]
need "listener 5e178676 tree 00e3a61d" [ "$(git -C $LREPO rev-parse '5e178676^{tree}')" = 00e3a61d48c91a6072355bf0ac67564490a6fc8b ]
need "helios ef320298 tree eec339e1" [ "$(git -C $HREPO rev-parse 'ef320298^{tree}')" = eec339e18296d850a514f72de2efdd8729302efd ]
need "listener repo clean" [ -z "$(git -C $LREPO status --porcelain --untracked-files=all)" ]
need "helios repo clean" [ -z "$(git -C $HREPO status --porcelain --untracked-files=all)" ]
need "original listener cargo home == manifest recorded by r1 (95d7ca22)" [ "$(treehash $CHL)" = $CH0 ]
echo "== 1 interrupted build A: integrity vs a fresh export (build-binaries.sh's export commands)"
need "A work dir and cache copy exist" [ -d $WA/listener ]; need "A cache copy exists" [ -d $HA ]
need "verify-export dir new" [ ! -e $V ]
mkdir -p $V/helios; git -C $HREPO archive --format=tar ef3202982b475212d9bb6adfdc3eed4ebb0b83c5 | tar -x -C $V/helios
mkdir -p $V/listener; git -C $LREPO archive --format=tar 5e178676bbe0ce5cda7ea95a3ccfefa8dca8a4b7 | tar -x -C $V/listener
mkdir -p $V/vendor-inspect/base-v1.5.1; tar -xzf $TAR -C $V/vendor-inspect/base-v1.5.1 --strip-components=1 "base-5476069f1eb74a56bccb56fdefd4b4bb0e3cda42/"
(cd $V/listener && python3 -I tools/prepare-upstream.py "$TAR") > $R/logs/r1r-verify-prepare.out 2>&1
for d in helios listener vendor-inspect; do need "A $d == fresh export" [ "$(treehash $WA/$d)" = "$(treehash $V/$d)" ]; done
need "A has nothing beyond helios, listener, vendor-inspect, target-listener" [ "$(ls $WA | tr '\n' ' ')" = "helios listener target-listener vendor-inspect " ]
diffs=$(diff <(cd $CHL && find . -type f | LC_ALL=C sort) <(cd $HA && find . -type f | LC_ALL=C sort) | grep '^[<>]' || true)
echo "[A cache] file-list differences vs original: ${diffs:-none}"
need "A cache: no original file missing" [ -z "$(echo "$diffs" | grep '^<' || true)" ]
need "A cache: only cargo lock/state files added" [ -z "$(echo "$diffs" | grep '^>' | grep -v -E '/\.package-cache(-mutate)?$|/\.global-cache$' || true)" ]
# cargo's own state files (.global-cache = its last-use SQLite DB, .package-cache* = lock files) change on every build and are not
# compile inputs; every other file (all crate sources and registry data) must be byte-identical
changed=$( (cd $CHL && find . -type f ! -name .global-cache ! -name '.package-cache*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | (cd $HA && sha256sum -c --quiet 2>&1) || true)
need "A cache: every file except cargo's own state (.global-cache, .package-cache*) byte-identical" [ -z "$changed" ]
echo "[A cache] cargo state files differing (expected, not compile inputs): $( (cd $CHL && sha256sum .global-cache .package-cache* 2>/dev/null) | (cd $HA && sha256sum -c 2>&1) | grep -c FAILED)"

echo "[A] partial target: $(find $WA/target-listener -type f | wc -l) files; final binary present: $([ -f $WA/target-listener/release/enclave-base-head-listener ] && echo yes || echo no)"
[ "${VERIFY_ONLY:-0}" = 1 ] && { echo "[r1r] VERIFY_ONLY: integrity OK, no compilation"; exit 0; }
echo "== 2 RESUME A in place (build-binaries.sh release environment, verbatim)"
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 CARGO_TERM_COLOR=never CARGO_PROFILE_DEV_DEBUG=0
date -u +%FT%TZ > $R/receipts/r1r-a-resume-started.utc
(cd $WA/listener && CARGO_HOME=$HA RUSTFLAGS="--remap-path-prefix=$WA=/build -C link-arg=-Wl,--threads=1 --remap-path-prefix=$HA=/cargo" CARGO_TARGET_DIR="$WA/target-listener" \
  timeout -k 10 5400 cargo build --locked --offline --profile release -p enclave-base-head-listener --bin enclave-base-head-listener) > $R/logs/r1r-build-a-resume.out 2>&1; arc=$?
date -u +%FT%TZ > $R/receipts/r1r-a-resume-finished.utc; tail -3 $R/logs/r1r-build-a-resume.out; echo "[A-resumed] rc=$arc"; [ $arc -eq 0 ] || rc=1
git -C $LREPO show 5e178676:Cargo.lock | cmp -s - $WA/listener/Cargo.lock && echo "[ok] A Cargo.lock unchanged" || { echo "[FAIL] A Cargo.lock changed"; rc=1; }
echo "== 3 B FRESH through build-binaries.sh"
need "B work dir and cache copy new" [ ! -e $WB ]; need "B cache copy new" [ ! -e $HB ]
cp -a $CHL $HB; need "B cache copy == original" [ "$(treehash $HB)" = $CH0 ]
LISTENER_CARGO_HOME=$HB bash $SCRIPT $WB $HREPO $LREPO $TAR $HB release listener > $R/logs/r1r-build-b.out 2>&1; brc=$?
tail -3 $R/logs/r1r-build-b.out; echo "[B] rc=$brc"; [ $brc -eq 0 ] || rc=1
echo "== 4 compare; originals unchanged"
need "original cargo home unchanged" [ "$(treehash $CHL)" = $CH0 ]
need "listener repo still clean" [ -z "$(git -C $LREPO status --porcelain --untracked-files=all)" ]
need "helios repo still clean" [ -z "$(git -C $HREPO status --porcelain --untracked-files=all)" ]
a=$(sha256sum < $WA/target-listener/release/enclave-base-head-listener 2>/dev/null | cut -c1-64); b=$(sha256sum < $WB/target-listener/release/enclave-base-head-listener 2>/dev/null | cut -c1-64)
printf '%s  r1r/A-resumed/enclave-base-head-listener\n%s  r1r/B-fresh/enclave-base-head-listener\n' "$a" "$b" > $R/receipts/r1r.sha256
echo "[result] A-resumed $a"; echo "[result] B-fresh   $b"; echo "[result] pin       $P"
[ -n "$b" ] && [ "$b" = "$P" ] && echo "[result] B (fresh) REPRODUCED the pin" || { echo "[result] B NOT equal to the pin"; rc=1; }
[ -n "$a" ] && [ "$a" = "$b" ] && echo "[result] A-resumed == B" || { echo "[result] A-resumed != B"; rc=1; }
echo "[r1r] rc=$rc"; exit $rc
