#!/bin/bash
# Build the native binaries of the local chain verifier runtime (network/rpc-runtime.mjs) from the pinned closure
# (scripts/rpc-runtime/closure.json), offline, in a fresh work directory:
#
#   build-binaries.sh <work-dir> <helios-git-repo> <listener-git-repo> <base-tarball> <cargo-home> [dev|release|check] [helios|witness-check|listener|all]
#
#   <helios-git-repo>    any git repository holding commits ef320298 (witness-check) and eeffcc9 (the Helios CLI base)
#   <listener-git-repo>  any git repository holding commit 5e178676
#   <base-tarball>       base/base 5476069f codeload tarball (sha256 9784e20a...)
#   <cargo-home>         a CARGO_HOME already holding every crate the Cargo.locks name (nothing is fetched);
#                        LISTENER_CARGO_HOME (env) may name a different one for the listener
#
# The sources are exported from the exact commits (git archive: no worktree, no untracked file) and their trees are
# checked; the base tree is extracted from the verified tarball into the relative path Helios names. The Helios CLI
# has its OWN tree <work>/helios-cli: eeffcc9 plus canonical-block.patch (next to this script, sha256-pinned below),
# applied with exact context, then checked file by file (verify-patched-tree.py: the manifest's files have their
# reviewed sha256, every other file equals eeffcc9, nothing missing or extra). witness-check is built from ef320298
# (<work>/helios) and the listener from 5e178676, as before. A wrong commit, tree, patch, manifest or Cargo.lock stops
# the build. Paths are remapped so the outputs do not name the build directory, so a digest from here is a NEW build:
# the runtime accepts it only once it is in PINNED_BUILDS with its own test evidence. Prints sha256 per binary and
# writes <work-dir>/BUILD.json.
# Profile `check` compiles nothing: it verifies the whole input closure (toolchain, tarball, trees, patch, generated
# manifest, every Cargo.lock) and resolves all three workspaces --locked --offline against the given cargo homes.
# Run it under the host's memory guard; it never raises a limit (one job, single-threaded link).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 5 ] || { sed -n '2,/^# Run it under/p' "$0"; exit 2; }
WORK=$1; HREPO=$2; LREPO=$3; TARBALL=$4; PROFILE=${6:-release}; ONLY=${7:-all}
export CARGO_HOME=$5
HELIOS=ef3202982b475212d9bb6adfdc3eed4ebb0b83c5 HELIOS_TREE=eec339e18296d850a514f72de2efdd8729302efd
CLI=eeffcc980a4a9aa092e23e07b1077c1f3fdfc95e CLI_TREE=2171ad2bfd3c97f2e0e029e866b1a8535cbbd187 CLI_EPOCH=1792720709
CLI_LOCK=28f4400cef93f04c28c2a0fe012cef917937c821560387456369ee88241cabc4
PATCH_SHA=41667ec946d2f591498e4ab9d791914a6d5c886221996c5f0c920a0be39dcc31 PATCHED_SHA=7e87fad838fcccdf801fa3ee732ca878b56799f44b4d64973a2265853769b0f3
LISTENER=5e178676bbe0ce5cda7ea95a3ccfefa8dca8a4b7 LISTENER_TREE=00e3a61d48c91a6072355bf0ac67564490a6fc8b
BASE_SHA=9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 BASE_COMMIT=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
case $PROFILE in dev|release|check) ;; *) echo "profile must be dev, release or check"; exit 2;; esac
case $ONLY in helios|witness-check|listener|all) ;; *) echo "binary must be helios, witness-check, listener or all"; exit 2;; esac
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 CARGO_TERM_COLOR=never
export CARGO_PROFILE_DEV_DEBUG=0
rustc --version | grep -q '^rustc 1\.96\.0 ' || { echo "rustc 1.96.0 required (installed toolchains only)"; exit 3; }
echo "$BASE_SHA  $TARBALL" | sha256sum -c --quiet - || { echo "base tarball is not $BASE_SHA"; exit 3; }
echo "$PATCH_SHA  $HERE/canonical-block.patch" | sha256sum -c --quiet - || { echo "canonical-block.patch is not $PATCH_SHA"; exit 3; }
echo "$PATCHED_SHA  $HERE/canonical-block.PATCHED.sha256" | sha256sum -c --quiet - || { echo "canonical-block.PATCHED.sha256 is not $PATCHED_SHA"; exit 3; }
[ -e "$WORK" ] && [ -n "$(ls -A "$WORK" 2>/dev/null)" ] && { echo "work dir $WORK must be new or empty"; exit 2; }
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
export_tree() { # <repo> <commit> <tree> <dest>
  [ "$(git -C "$1" rev-parse "$2^{tree}")" = "$3" ] || { echo "$2 in $1 does not have tree $3"; exit 3; }
  mkdir -p "$4"; git -C "$1" archive --format=tar "$2" | tar -x -C "$4"
}
export_tree "$HREPO" $HELIOS $HELIOS_TREE "$WORK/helios"
export_tree "$HREPO" $CLI $CLI_TREE "$WORK/helios-cli"
[ "$(git -C "$HREPO" log -1 --format=%ct $CLI)" = $CLI_EPOCH ] || { echo "$CLI commit time is not $CLI_EPOCH"; exit 3; }
echo "$CLI_LOCK  $WORK/helios-cli/Cargo.lock" | sha256sum -c --quiet - || { echo "$CLI Cargo.lock is not $CLI_LOCK"; exit 4; }
(cd "$WORK/helios-cli" && GIT_CEILING_DIRECTORIES="$WORK" git apply --check "$HERE/canonical-block.patch" \
  && GIT_CEILING_DIRECTORIES="$WORK" git apply "$HERE/canonical-block.patch") || { echo "canonical-block.patch does not apply exactly to $CLI"; exit 4; }
python3 -I "$HERE/verify-patched-tree.py" "$HREPO" $CLI "$WORK/helios-cli" "$HERE/canonical-block.PATCHED.sha256" || { echo "the patched Helios CLI tree is not the reviewed one"; exit 4; }
export_tree "$LREPO" $LISTENER $LISTENER_TREE "$WORK/listener"
mkdir -p "$WORK/vendor-inspect/base-v1.5.1"
tar -xzf "$TARBALL" -C "$WORK/vendor-inspect/base-v1.5.1" --strip-components=1 "base-$BASE_COMMIT/"
(cd "$WORK/listener" && python3 -I tools/prepare-upstream.py "$TARBALL")
git -C "$LREPO" show $LISTENER:Cargo.toml | cmp -s - "$WORK/listener/Cargo.toml" || { echo "prepare-upstream changed the listener root Cargo.toml"; exit 4; }
lock_of() { case $1 in helios) git -C "$HREPO" show $HELIOS:Cargo.lock;; helios-cli) git -C "$HREPO" show $CLI:Cargo.lock;; listener) git -C "$LREPO" show $LISTENER:Cargo.lock;; esac; }
locks_unchanged() { local d; for d in helios helios-cli listener; do lock_of $d | cmp -s - "$WORK/$d/Cargo.lock" || { echo "$d Cargo.lock changed"; exit 4; }; done; }
if [ $PROFILE = check ]; then
  for d in helios helios-cli listener; do
    home=$CARGO_HOME; [ $d = listener ] && home=${LISTENER_CARGO_HOME:-$CARGO_HOME}
    (cd "$WORK/$d" && CARGO_HOME=$home cargo metadata --locked --offline --format-version 1 > "$WORK/metadata-$d.json") || { echo "$d does not resolve --locked --offline"; exit 5; }
    lock_of $d | cmp -s - "$WORK/$d/Cargo.lock" || { echo "$d Cargo.lock changed"; exit 4; }
    echo "$d: resolves --locked --offline; packages $(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["packages"]))' "$WORK/metadata-$d.json"); lock $(sha256sum "$WORK/$d/Cargo.lock" | cut -c1-64)"
  done
  echo "$(rustc --version); base $BASE_SHA; helios $HELIOS tree $HELIOS_TREE; helios-cli $CLI tree $CLI_TREE + patch $PATCH_SHA; listener $LISTENER tree $LISTENER_TREE"
  echo CLOSURE_CHECK_OK
  exit 0
fi
export RUSTFLAGS="--remap-path-prefix=$WORK=/build -C link-arg=-Wl,--threads=1"
out=$([ $PROFILE = dev ] && echo debug || echo release)
declare -A SHA
build() { # <dir> <name> <cargo args...>
  local dir=$1 name=$2 home=$CARGO_HOME; shift 2
  [ $dir = listener ] && home=${LISTENER_CARGO_HOME:-$CARGO_HOME}
  echo "=== $(date -u +%FT%TZ) $name ($PROFILE, CARGO_HOME $home)"
  (cd "$WORK/$dir" && CARGO_HOME=$home RUSTFLAGS="$RUSTFLAGS --remap-path-prefix=$home=/cargo" CARGO_TARGET_DIR="$WORK/target-$dir" \
    timeout -k 10 5400 cargo build --locked --offline --profile $PROFILE "$@")
  SHA[$name]=$(sha256sum "$WORK/target-$dir/$out/$name" | cut -c1-64)
  echo "$name ${SHA[$name]}"
}
[[ $ONLY == all || $ONLY == listener ]] && build listener enclave-base-head-listener -p enclave-base-head-listener --bin enclave-base-head-listener
[[ $ONLY == all || $ONLY == witness-check ]] && build helios witness-check -p helios-opstack --bin witness-check
# the CLI's own tree; SOURCE_DATE_EPOCH = eeffcc9's commit time (the vendored OpenSSL build stamp), as the tested build
[[ $ONLY == all || $ONLY == helios ]] && SOURCE_DATE_EPOCH=$CLI_EPOCH build helios-cli helios -p helios-cli --bin helios
locks_unchanged
{ echo '{'; echo " \"format\": \"enclave-rpc-runtime-build/v1\", \"profile\": \"$PROFILE\", \"rustc\": \"$(rustc --version)\","
  echo " \"helios\": \"$HELIOS\", \"listener\": \"$LISTENER\", \"baseTarballSha256\": \"$BASE_SHA\", \"rustflags\": \"remapped work/cargo paths, single-threaded link\","
  echo " \"heliosCli\": { \"commit\": \"$CLI\", \"tree\": \"$CLI_TREE\", \"patchSha256\": \"$PATCH_SHA\", \"patchedManifestSha256\": \"$PATCHED_SHA\", \"sourceDateEpoch\": $CLI_EPOCH },"
  echo " \"sha256\": {"; first=1; for k in "${!SHA[@]}"; do [ $first = 1 ] || echo ','; first=0; printf '  "%s": "%s"' "$k" "${SHA[$k]}"; done; echo; echo ' }'; echo '}'; } > "$WORK/BUILD.json"
cat "$WORK/BUILD.json"
