#!/bin/bash
# M7 PRODUCTION CANDIDATE build of the full Base node binary (package `base`, bin `base`) from pristine base/base 5476069f +
# the validated M7 patch (e9dfb8c6...). ROOT-LAUNCHED, FOREGROUND, OFFLINE:
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1792 --log $P/logs/build-1.guard -- \
#     env RUN=1 unshare -rn bash $P/build.sh > $P/logs/build-1.out 2>&1; echo $? > $P/logs/build-1.rc
# - Re-derives and diffs the source (git archive 5476069f + git apply patch == build/src) and checks the pins BEFORE compiling.
# - Compiles ONLY `cargo build --locked --offline -p base --bin base` with the reviewable profile m7-release-nolto (defined by
#   --config, no source edit): Base's [profile.release] (opt-level 3, debug none, strip symbols, codegen-units 16, panic
#   unwind) EXCEPT lto=false (upstream release uses thin LTO, whose whole-program step is expected to exceed the 1792 MiB cap).
# - CARGO_BUILD_JOBS=1, lld single-threaded, SOURCE_DATE_EPOCH = the base commit time, Rust + C path prefixes remapped.
# - PRIVATE build/cargo-home (read + crate extraction only), SEPARATE target $P/target-$RUN (never build/target); no network
#   (unshare -rn): a missing dependency fails, nothing is fetched.
# - Afterwards: sha256 + ELF facts of the binary, bounded --version/--help smoke, and the M7 flag in some subcommand's help.
# This is ONE build: no reproducibility claim until an independent second build (RUN=2, other target dir) matches.
set -uo pipefail
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" GIT_OPTIONAL_LOCKS=0
PB=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build  # RESUME: fixed RUN 1 location (this body lives in recovery/)
. "$PB/../jobs/env.sh"
ip link set lo up 2>/dev/null || true
P=$PB; RUN=${RUN:?RUN=1|2}; TGT=$P/target-$RUN; OUT=$P/out-$RUN; S=$BUILD/src; RD=$P/recovery/derived-$RUN-r${RESUME:?}  # RESUME: source re-derivation outside out-1
die() { echo "## INVALID/FAILED: $*"; echo "## rc=1"; exit 1; }
[[ "$RUN" = 1 ]] || die "RESUME is for RUN 1 only"
need() { local w=$1; shift; "$@" && echo "[ok] $w" || die "$w"; }
PROFILE=m7-release-nolto; EPOCH=1792689943
need "RESUME: RUN 1 target retained ($TGT/$PROFILE)" [ -d "$TGT/$PROFILE/.fingerprint" ]
need "RESUME: no RUN 1 artifact yet (out-1/base absent)" [ ! -e "$OUT/base" ]
need "RESUME: no linked binary yet ($PROFILE/base absent)" [ ! -e "$TGT/$PROFILE/base" ]
need "RESUME: derivation dir new" [ ! -e "$RD" ]
ifs=$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d ' ' | sort | tr '\n' ' '); need "offline: interfaces lo only ($ifs)" [ "$ifs" = "lo " ]
echo "== pins and provenance (before compiling)"
need "rustc 1.96.0" bash -c "rustc --version | grep -q '^rustc 1\.96\.0 (ac68faa20'"
need "base repo HEAD $BASE_REV" [ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ]
need "base commit time == SOURCE_DATE_EPOCH $EPOCH" [ "$(git -C "$BASE_REPO" log -1 --format=%ct "$BASE_REV")" = $EPOCH ]
need "patch e9dfb8c6" [ "$(sha256sum < "$PATCH" | cut -c1-64)" = e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312 ]
need "provider == validated 201d9b8c16b080a4f7111ca29ec5ece8f02a2b9be807bb06e24e7eb1248bb3b2" [ "$(sha256sum < "$S/crates/consensus/providers/src/chain_provider.rs" | cut -c1-64)" = 201d9b8c16b080a4f7111ca29ec5ece8f02a2b9be807bb06e24e7eb1248bb3b2 ]
need "Cargo.lock f122da76" [ "$(sha256sum < "$S/Cargo.lock" | cut -c1-64)" = f122da76b80d5df44c9dc0c6fc4efc335abe295280fa49325f367ddcfc7b6a8f ]
need "CLI default l1 trust-rpc = false" grep -q '^const DEFAULT_L1_TRUST_RPC: bool = false;$' "$S/crates/consensus/cli/src/l1.rs"
mkdir -p "$RD"; git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$RD"; (cd "$RD" && git apply "$PATCH")
need "build/src == git archive $BASE_REV + patch (no other difference)" bash -c "[ -z \"\$(diff -rq '$RD' '$S' 2>&1)\" ]"
rm -rf "$RD"  # RESUME: only this run's own recovery/derived-* copy
SRCM=$( (cd "$S" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-64); echo "[pin] source tree manifest $SRCM"
need "source manifest d8078bdf (dry check)" [ "$SRCM" = d8078bdf5dbab667478329f8e31dac7cac4c780404982cf535d93dd109ca6efb ]
RETH=$(ls -d "$CARGO_HOME"/git/checkouts/reth-*/7134be3 2>/dev/null | head -1)
need "reth checkout present" [ -d "$RETH" ]
need "reth checkout HEAD 7134be3b51cf9d9504f988bff3266a23085f0bd9 (embedded by vergen)" [ "$(git -C "$RETH" rev-parse HEAD)" = 7134be3b51cf9d9504f988bff3266a23085f0bd9 ]
need "reth checkout: tracked files clean" [ -z "$(git -C "$RETH" status --porcelain --untracked-files=no)" ]
need "reth checkout: only cargo's .cargo-ok untracked (vergen may still report dirty => '-dev' version suffix; deterministic)" [ "$(git -C "$RETH" status --porcelain --untracked-files=all)" = "?? .cargo-ok" ]
echo "[cache] CARGO_HOME files before: $(find "$CARGO_HOME" -type f | wc -l)"
[ "${DRY:-0}" = 1 ] && { echo "## DRY: every pre-compile check passed; nothing compiled; target-1/out-1 untouched"; exit 0; }
echo "== build: RESUME of RUN 1 in the retained target (cargo rebuilds only unfinished units) ($(date -u +%FT%TZ))"
export CARGO_TARGET_DIR=$TGT CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 SOURCE_DATE_EPOCH=$EPOCH CARGO_NET_OFFLINE=true
export RUSTFLAGS="-C link-arg=-Wl,--threads=1 --remap-path-prefix=$S=/build/base --remap-path-prefix=$CARGO_HOME=/cargo --remap-path-prefix=$TGT=/target"
export CFLAGS="-ffile-prefix-map=$S=/build/base -ffile-prefix-map=$CARGO_HOME=/cargo -ffile-prefix-map=$TGT=/target"
export CXXFLAGS="$CFLAGS"
echo "[env] RUSTUP_TOOLCHAIN=$RUSTUP_TOOLCHAIN CARGO_BUILD_JOBS=1 SOURCE_DATE_EPOCH=$EPOCH RUSTFLAGS='$RUSTFLAGS' CFLAGS='$CFLAGS'"
cd "$S"
timeout -k 30 43200 cargo build --locked --offline -p base --bin base \
  --config "profile.$PROFILE.inherits=\"release\"" --config "profile.$PROFILE.lto=false" --profile $PROFILE; r=$?
echo "## cargo build rc=$r ($(date -u +%FT%TZ))"; [ $r = 0 ] || die "cargo build failed (rc $r)"
B=$TGT/$PROFILE/base; need "binary exists" [ -x "$B" ]
mkdir -p "$OUT"; cp -p "$B" "$OUT/base"
echo "== artifact"; echo "[artifact] $(sha256sum "$OUT/base" | cut -c1-64)  base  ($(stat -c %s "$OUT/base") bytes)"
readelf -n "$OUT/base" | grep -i "build id"; readelf -p .comment "$OUT/base" 2>/dev/null | grep -v '^$\|String dump' | sort -u
echo "[artifact] dynamic deps: $(readelf -d "$OUT/base" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | tr '\n' ' ')"
echo "[artifact] build-path strings (should be 0): $(strings -n 8 "$OUT/base" | grep -c -e "$S" -e "$CARGO_HOME" -e "$TGT")"
echo "[cache] CARGO_HOME files after: $(find "$CARGO_HOME" -type f | wc -l)"
echo "== smoke (bounded, no network, no data dir)"
cd "$OUT"; export HOME=$OUT/home; mkdir -p "$HOME"
timeout 30 ./base --version > smoke-version.txt 2>&1; v=$?; cat smoke-version.txt; need "base --version rc 0" [ $v = 0 ]
timeout 30 ./base --help > smoke-help.txt 2>&1; h=$?; need "base --help rc 0" [ $h = 0 ]
found=""
for sub in $(sed -n '/^Commands:/,/^$/p' smoke-help.txt | awk 'NR>1 && $1!="help" {print $1}'); do
  timeout 30 ./base $sub --help > "smoke-help-$sub.txt" 2>&1
  grep -q 'BASE_NODE_L1_TRUST_RPC' "smoke-help-$sub.txt" && found="$found $sub"
  for sub2 in $(sed -n '/^Commands:/,/^$/p' "smoke-help-$sub.txt" | awk 'NR>1 && $1!="help" {print $1}'); do
    timeout 30 ./base $sub $sub2 --help > "smoke-help-$sub-$sub2.txt" 2>&1 && grep -q 'BASE_NODE_L1_TRUST_RPC' "smoke-help-$sub-$sub2.txt" && found="$found $sub/$sub2"
  done
done
echo "[smoke] subcommands exposing the M7 flag (env BASE_NODE_L1_TRUST_RPC): ${found:-none}"
need "M7 flag present in the CLI" [ -n "$found" ]
f=$(echo $found | cut -d' ' -f1 | tr '/' ' '); grep -h -A3 'l1.trust-rpc\|l1-trust-rpc' "smoke-help-${f// /-}.txt" | head -8
(cd "$OUT" && sha256sum base smoke-*.txt > SHA256SUMS)
echo "## rc=0 (RESUMED RUN 1 after a kernel OOM; ONE build: NOT a fresh independent build, NOT a reproducibility claim)"
