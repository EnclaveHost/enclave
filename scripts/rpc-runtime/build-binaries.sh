#!/bin/bash
# Build the native binaries of the local chain verifier runtime (network/rpc-runtime.mjs) from the pinned closure
# (scripts/rpc-runtime/closure.json), offline, in a fresh work directory:
#
#   build-binaries.sh <work-dir> <helios-git-repo> <listener-git-repo> <base-tarball> <cargo-home> [dev|release] [helios|witness-check|listener|all]
#
#   <helios-git-repo>    any git repository holding commit aca81764 (rebuilt from the checkpoint patches, or a clone)
#   <listener-git-repo>  any git repository holding commit 5e178676
#   <base-tarball>       base/base 5476069f codeload tarball (sha256 9784e20a...)
#   <cargo-home>         a CARGO_HOME already holding every crate the Cargo.locks name (nothing is fetched);
#                        LISTENER_CARGO_HOME (env) may name a different one for the listener
#
# The sources are exported from the exact commits (git archive: no worktree, no untracked file) and their trees are
# checked; the base tree is extracted from the verified tarball into the relative path Helios names. Paths are remapped
# so the outputs do not name the build directory. Prints sha256 per binary and writes <work-dir>/BUILD.json.
# Run it under the host's memory guard; it never raises a limit (one job, single-threaded link).
set -euo pipefail
[ $# -ge 5 ] || { sed -n 2,16p "$0"; exit 2; }
WORK=$1; HREPO=$2; LREPO=$3; TARBALL=$4; PROFILE=${6:-release}; ONLY=${7:-all}
export CARGO_HOME=$5
HELIOS=aca81764f1d41a34829a3b408cea11c5c186e9e9 HELIOS_TREE=082c719ec1d63ea923f65cb14598f78efff07e5c
LISTENER=5e178676bbe0ce5cda7ea95a3ccfefa8dca8a4b7 LISTENER_TREE=00e3a61d48c91a6072355bf0ac67564490a6fc8b
BASE_SHA=9784e20a3cfeac555d96e8d1f15526d5264f0e6d8885b951c6f1220355038012 BASE_COMMIT=5476069f1eb74a56bccb56fdefd4b4bb0e3cda42
case $PROFILE in dev|release) ;; *) echo "profile must be dev or release"; exit 2;; esac
export RUSTUP_TOOLCHAIN=1.96.0 RUSTUP_AUTO_INSTALL=0 CARGO_NET_OFFLINE=true CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 CARGO_TERM_COLOR=never
export CARGO_PROFILE_DEV_DEBUG=0
rustc --version | grep -q '^rustc 1\.96\.0 ' || { echo "rustc 1.96.0 required (installed toolchains only)"; exit 3; }
echo "$BASE_SHA  $TARBALL" | sha256sum -c --quiet - || { echo "base tarball is not $BASE_SHA"; exit 3; }
[ -e "$WORK" ] && [ -n "$(ls -A "$WORK" 2>/dev/null)" ] && { echo "work dir $WORK must be new or empty"; exit 2; }
mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
export_tree() { # <repo> <commit> <tree> <dest>
  [ "$(git -C "$1" rev-parse "$2^{tree}")" = "$3" ] || { echo "$2 in $1 does not have tree $3"; exit 3; }
  mkdir -p "$4"; git -C "$1" archive --format=tar "$2" | tar -x -C "$4"
}
export_tree "$HREPO" $HELIOS $HELIOS_TREE "$WORK/helios"
export_tree "$LREPO" $LISTENER $LISTENER_TREE "$WORK/listener"
mkdir -p "$WORK/vendor-inspect/base-v1.5.1"
tar -xzf "$TARBALL" -C "$WORK/vendor-inspect/base-v1.5.1" --strip-components=1 "base-$BASE_COMMIT/"
(cd "$WORK/listener" && python3 -I tools/prepare-upstream.py "$TARBALL")
git -C "$LREPO" show $LISTENER:Cargo.toml | cmp -s - "$WORK/listener/Cargo.toml" || { echo "prepare-upstream changed the listener root Cargo.toml"; exit 4; }
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
[[ $ONLY == all || $ONLY == helios ]] && build helios helios -p helios-cli --bin helios
(cd "$WORK/helios" && git -C "$HREPO" show $HELIOS:Cargo.lock | cmp -s - Cargo.lock) || { echo "Helios Cargo.lock changed"; exit 4; }
(cd "$WORK/listener" && git -C "$LREPO" show $LISTENER:Cargo.lock | cmp -s - Cargo.lock) || { echo "listener Cargo.lock changed"; exit 4; }
{ echo '{'; echo " \"format\": \"enclave-rpc-runtime-build/v1\", \"profile\": \"$PROFILE\", \"rustc\": \"$(rustc --version)\","
  echo " \"helios\": \"$HELIOS\", \"listener\": \"$LISTENER\", \"baseTarballSha256\": \"$BASE_SHA\", \"rustflags\": \"remapped work/cargo paths, single-threaded link\","
  echo " \"sha256\": {"; first=1; for k in "${!SHA[@]}"; do [ $first = 1 ] || echo ','; first=0; printf '  "%s": "%s"' "$k" "${SHA[$k]}"; done; echo; echo ' }'; echo '}'; } > "$WORK/BUILD.json"
cat "$WORK/BUILD.json"
