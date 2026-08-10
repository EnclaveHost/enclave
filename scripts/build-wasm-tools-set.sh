#!/usr/bin/env bash
# build-wasm-tools-set.sh — build the upload gateway's `wasm-tools` from the SAME
# relaxed wasmparser the SET engine runs.
#
# Why this exists: the gateway's Tier 2 check (`wasm-tools validate --features
# all`, see scripts/ipfs-add-gateway.py) is meant to be a *preview of the
# engine*: reject at publish time what the runner would refuse at launch. A
# stock wasm-tools is no longer that. wasm/wasmparser-set-relax.patch relaxes
# two validator rules for shared-everything-threads guests — the synthesized
# `thread.spawn*` import follows the declared spawn type, and `cabi_memory_at`
# accepts a SHARED canonical-ABI memory — and wasm/Dockerfile.wasmtime vendors
# that fork into the engine. Upstream wasm-tools does not carry it, so it
# rejects every SET component the fleet can actually run:
#
#   upload rejected: wasm validation failed: error: mismatch in the shared flag
#   for memories (at offset 0x30b8d2)
#
# (that offset is risc-box's SET build; `cabi_memory_at` compares the component's
# shared memory against a hardcoded `shared: false`). A validator STRICTER than
# the engine is a false refusal; one LOOSER admits what the engine won't launch.
# Matching is the whole point, so this script pins the fork to the engine's:
#
#   * the same wasmparser version + sha256 as wasm/Dockerfile.wasmtime,
#   * the same wasm/wasmparser-set-relax.patch, applied to the same crate root,
#   * and it PROVES the equivalence rather than assuming it: the wasm-tools git
#     tag's crates/wasmparser/src is diffed against the sha-pinned crates.io
#     tarball the engine vendors, and the build aborts if they differ.
#
# Output: ./dist/wasm-tools-set — a static x86_64 musl binary (no libc floor, so
# it runs on the gateway VM whatever its distro). Ship it with
# scripts/deploy-wasm-tools-set.sh.
#
# Rebuild when: wasmparser-set-relax.patch changes, or WASMPARSER_VERSION in
# wasm/Dockerfile.wasmtime moves. Both mean the engine's validator moved and the
# gateway's copy is now lying about what will launch.
set -euo pipefail
cd "$(dirname "$0")/.."

# Keep in lockstep with wasm/Dockerfile.wasmtime's ARGs. wasm-tools and
# wasmparser ship from one repo on one release train: the CLI is 1.N.0 where the
# library crates are 0.N.0, so v1.254.0 IS wasmparser 0.254.0.
WASM_TOOLS_TAG="${WASM_TOOLS_TAG:-v1.254.0}"
WASMPARSER_VERSION="${WASMPARSER_VERSION:-0.254.0}"
WASMPARSER_SHA256="${WASMPARSER_SHA256:-d5769a29f799fbab136aaf65b4fe5384cd7d93fe6fc9ba0dcb6c8382a1f16e27}"
# The same pinned toolchain image the engine builds under.
RUST_IMAGE="${RUST_IMAGE:-rust:1.97-bookworm@sha256:14bc9c5966e7b3a385794b3d5389a8765668342025fbcc7b2e3d2866ac4bd8c3}"

mkdir -p dist

docker run --rm \
  -v "$PWD/wasm/wasmparser-set-relax.patch:/patch/wasmparser-set-relax.patch:ro" \
  -v "$PWD/dist:/out" \
  -e WASM_TOOLS_TAG="$WASM_TOOLS_TAG" \
  -e WASMPARSER_VERSION="$WASMPARSER_VERSION" \
  -e WASMPARSER_SHA256="$WASMPARSER_SHA256" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$RUST_IMAGE" bash -euo pipefail -c '
    git clone --depth 1 --branch "${WASM_TOOLS_TAG}" \
      https://github.com/bytecodealliance/wasm-tools.git /src
    cd /src

    # Prove the tag ships the exact wasmparser the engine vendors. The engine
    # takes the crates.io tarball (sha-pinned); we take the git tag. If those
    # two ever diverge the gateway would validate against a DIFFERENT parser
    # than the runner — the one failure this script exists to prevent — so it
    # is an error, not a warning.
    curl -sSLf -o /tmp/wasmparser.crate \
      "https://static.crates.io/crates/wasmparser/wasmparser-${WASMPARSER_VERSION}.crate"
    echo "${WASMPARSER_SHA256}  /tmp/wasmparser.crate" | sha256sum -c -
    mkdir -p /tmp/wp && tar -xzf /tmp/wasmparser.crate -C /tmp/wp --strip-components=1
    diff -rq /tmp/wp/src crates/wasmparser/src
    echo "wasmparser ${WASMPARSER_VERSION}: git tag == sha-pinned crate, verified"

    # Same patch, same crate root as the Dockerfile.wasmtime vendor step
    # (a plain unified diff against the crate, hence -p1 -d crates/wasmparser).
    patch -p1 -d crates/wasmparser --dry-run < /patch/wasmparser-set-relax.patch
    patch -p1 -d crates/wasmparser         < /patch/wasmparser-set-relax.patch

    # Static musl: the gateway VM is not this build image, and a validator that
    # cannot exec is indistinguishable from WASM_TOOLS being unset (Tier 2
    # silently degrades to header-only). No libc floor, no surprise.
    rustup target add x86_64-unknown-linux-musl
    cargo build --release --bin wasm-tools --target x86_64-unknown-linux-musl

    cp target/x86_64-unknown-linux-musl/release/wasm-tools /out/wasm-tools-set
    chmod 0755 /out/wasm-tools-set
    chown "${HOST_UID}:${HOST_GID}" /out/wasm-tools-set
  '

echo
echo "built: dist/wasm-tools-set"
file dist/wasm-tools-set || true
sha256sum dist/wasm-tools-set
./dist/wasm-tools-set --version
