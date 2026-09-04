#!/bin/sh
# The enclave wasm64 toolchain: everything needed to build a guest that
# addresses MORE THAN 4 GiB, as a memory64 wasip2 COMPONENT.
#
# This is the only >4 GiB guest class the platform runs. It replaces the
# earlier wasm64-wasip1 CORE MODULE path (Dockerfile.wasm64c-build), which
# could only be a portless compute guest because preview1 has no socket
# surface on the engine. A memory64 component is an ordinary wasip2 app —
# ports, sockets, HTTP — that happens to address more than 4 GiB.
#
# Serves BOTH languages:
#   C/C++  build-c.sh    (clang, the mem64-marshalled wasip2 sysroot)
#   Rust   build-rust.sh (std from source for a custom wasm64 target)
#
# Host needs: curl, git, tar, cmake >= 3.26, ninja, python3, patch, and rustup
# with a nightly carrying rust-src + wasm32-wasip2
# (`rustup toolchain install nightly -c rust-src -t wasm32-wasip2`). A stable
# toolchain is used for wac if present (its lock pins a rustix that newer
# nightlies reject); nightly is the fallback.
#
# Everything lands in $W64 (default ~/.cache/enclave-w64) and every component
# is skipped when its output already exists, so a failed step can be re-run.
# Dockerfile.wasm64p2-build is this script in an image.
#
# What gets built, and why (the full story is in docs/wasm64.md):
#
#   wasi-sdk        clang 23 + wasm-ld 23, the platform's pin; wasi-libc's
#                   wasip2 build needs its `-fdefer-ts`.
#   wasi-libc       the platform's pinned rev with wasi-libc-mem64.patch
#                   (musl assumes 32-bit pointers in its atomics), built for
#                   wasm64-wasip2 and installed as sysroot64. Its checked-in
#                   `wasip2_component_type.o` is a wasm32 object; it is
#                   regenerated for wasm64 (regen_component_type.py) and
#                   swapped into libc.a, or wasm-ld refuses the archive.
#   compiler-rt     builtins for wasm64, from the EXACT llvm commit the SDK's
#                   clang came from (the SDK ships wasm32 builtins only).
#                   wasm-ld hard-requires them; Rust brings its own, so this
#                   is what makes the C/C++ path link at all.
#   wasm-tools      v1.256.0 with wit-component-memory64.patch: the component
#                   encoder followed a hardcoded 32-bit pointer width; this
#                   makes it follow the core module's memory.
#   wac             the composition tool (`wac plug`), moved to the same
#                   wasm-tools crates so it can read a memory64 component.
#   wasiproxy       the wasm32 WASI pass-through every memory64 component is
#                   plugged into (see wasiproxy/README.md: the engine's
#                   host-side typed ABI is 32-bit, its component-to-component
#                   adapters are not).
#   wit-bindgen     0.57.1 (std's), patched: cabi_realloc rt built for wasm64
#                   with clang, runtime cfg gates widened to any wasm.
#   wasip2          1.0.4 (std's wasi 0.2 bindings): every import is stubbed
#                   with unreachable!() off wasm32 — the gates are widened.
#   getrandom       0.2.17 and 0.4.3: WASI backend gated on wasm32; widened,
#                   and 0.2 gets a wasi 0.2 backend for wasm64 (there is no
#                   preview1 adapter for a 64-bit memory).
#   rustsrc         a copy of this nightly's library/ widened for wasm64
#                   (std-wasm64.sh), with the patched crates wired in.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
W64="${W64:-$HOME/.cache/enclave-w64}"
RUST_TC="${RUST_TC:-nightly}"   # the nightly toolchain name; the Dockerfile pins a dated one
mkdir -p "$W64" && W64="$(cd "$W64" && pwd)"
P="$HERE/patches"
log() { echo "[w64-prepare] $*"; }
# the memory64 wasi-libc patch is the platform's canonical copy one level up
LIBC_PATCH="${LIBC_PATCH:-$HERE/../wasi-libc-mem64.patch}"
need() { command -v "$1" >/dev/null 2>&1 || { echo "[w64-prepare] missing: $1"; exit 2; }; }
for t in curl git tar cmake ninja python3 patch cargo rustup; do need "$t"; done
rustup component list --installed --toolchain "$RUST_TC" 2>/dev/null | grep -q '^rust-src' \
  || { echo "[w64-prepare] nightly needs rust-src: rustup component add rust-src --toolchain $RUST_TC"; exit 2; }
rustup target list --installed --toolchain "$RUST_TC" 2>/dev/null | grep -q '^wasm32-wasip2' \
  || { echo "[w64-prepare] nightly needs wasm32-wasip2 (for the proxy): rustup target add wasm32-wasip2 --toolchain $RUST_TC"; exit 2; }
if rustup run stable cargo --version >/dev/null 2>&1; then STABLE="+stable"; else STABLE="+$RUST_TC"; fi

# crates.io sources, fetched as the published tarballs (no registry cache needed)
crate() { # crate <name> <version> <dest>
  [ -d "$3" ] && return 0
  log "fetching $1 $2"
  mkdir -p "$W64/dl"
  curl -fsSL -o "$W64/dl/$1-$2.crate" "https://static.crates.io/crates/$1/$1-$2.crate"
  mkdir -p "$3.tmp" && tar -xzf "$W64/dl/$1-$2.crate" -C "$3.tmp" --strip-components=1
  mv "$3.tmp" "$3"
}

# 1. wasi-sdk 34 rc.2 (clang 23) — the platform's pin
WASI_SDK_URL="${WASI_SDK_URL:-https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34-rc.2/wasi-sdk-34.0-rc.2-x86_64-linux.tar.gz}"
if [ ! -x "$W64/wasi-sdk/bin/clang" ]; then
  log "fetching wasi-sdk"
  mkdir -p "$W64/dl" && curl -fsSL -o "$W64/dl/wasi-sdk.tgz" "$WASI_SDK_URL"
  mkdir -p "$W64/wasi-sdk" && tar -xzf "$W64/dl/wasi-sdk.tgz" -C "$W64/wasi-sdk" --strip-components=1
fi
"$W64/wasi-sdk/bin/clang" --version | grep -q "clang version 2[3-9]" || { echo "[w64-prepare] wasi-sdk clang is not >= 23"; exit 1; }
CLANG="$W64/wasi-sdk/bin/clang"; AR="$W64/wasi-sdk/bin/llvm-ar"

# 2. wasi-libc for wasm64-wasip2 -> sysroot64
WASI_LIBC_REV="${WASI_LIBC_REV:-6d8745c8cec1aaa82c24f2e3d7a544f7ea9c2089}"
if [ ! -f "$W64/sysroot64/lib/wasm64-wasip2/libc.a" ]; then
  if [ ! -d "$W64/wasi-libc/.git" ]; then
    log "fetching wasi-libc $WASI_LIBC_REV"
    rm -rf "$W64/wasi-libc" && git init -q "$W64/wasi-libc"
    ( cd "$W64/wasi-libc" && git remote add origin https://github.com/WebAssembly/wasi-libc \
      && git fetch -q --depth 1 origin "$WASI_LIBC_REV" && git checkout -q FETCH_HEAD \
      && git apply --check "$LIBC_PATCH" && git apply "$LIBC_PATCH" )
  fi
  log "building wasi-libc for wasm64-wasip2"
  ( cd "$W64/wasi-libc" \
    && cmake -G Ninja -S . -B build64 -DTARGET_TRIPLE=wasm64-wasip2 -DBUILD_SHARED=OFF \
         -DCMAKE_C_COMPILER="$CLANG" -DCMAKE_AR="$AR" -DCMAKE_NM="$W64/wasi-sdk/bin/llvm-nm" \
         -DCMAKE_RANLIB="$W64/wasi-sdk/bin/llvm-ranlib" -DCMAKE_LINK_DEPENDS_USE_LINKER=OFF \
         -DCMAKE_INSTALL_PREFIX="$W64/sysroot64" >/dev/null \
    && ninja -C build64 >/dev/null && ninja -C build64 install >/dev/null )
  # the wasip2 bottom half must be there: sockets and the wasi 0.2 random
  # entry points (the wasip1 marshalling shim the platform asserts on is not
  # part of a wasip2 build)
  for sym in "T socket" "T connect" "T random_get_random_bytes"; do
    "$W64/wasi-sdk/bin/llvm-nm" "$W64/sysroot64/lib/wasm64-wasip2/libc.a" 2>/dev/null | grep -q " $sym\$" \
      || { echo "[w64-prepare] wasm64 libc.a lacks $sym"; exit 1; }
  done
  # the component-type objects: wasm32 relocatables in a wasm64 archive
  tmp="$(mktemp -d)"
  for o in wasip2_component_type.o wasip3_component_type.o; do
    src="$W64/wasi-libc/libc-bottom-half/sources/$o"; [ -f "$src" ] || continue
    python3 "$HERE/regen_component_type.py" "$src" "$tmp/$o" --clang "$CLANG" --target wasm64-wasip2
    "$AR" r "$W64/sysroot64/lib/wasm64-wasip2/libc.a" "$tmp/$o"
  done
  rm -rf "$tmp"
  for f in crt1-command.o crt1-reactor.o crt1.o; do
    [ -f "$W64/sysroot64/lib/wasm64-wasip2/$f" ] || { echo "[w64-prepare] sysroot64 lacks $f"; exit 1; }
  done
fi

# 2b. compiler-rt builtins for wasm64. wasm-ld hard-requires
# libclang_rt.builtins.a for the target and the SDK ships wasm32 only. Built
# from the EXACT llvm-project commit the SDK's clang identifies itself with
# (its --version string carries the sha), sparse-checkouted so the fetch is
# the builtins and cmake support rather than the whole monorepo. Rust brings
# its own (the compiler_builtins crate), so this is the link that makes C/C++
# work — without it clang stops at "cannot open libclang_rt.builtins.a".
LLVM_REV="${LLVM_REV:-278c31bfb8ceb7ea17dbfd11a4fb21e6634af957}"
RTDIR="$("$CLANG" -print-resource-dir)/lib/wasm64-unknown-wasip2"
if [ ! -f "$RTDIR/libclang_rt.builtins.a" ]; then
  if [ ! -d "$W64/llvm-project/.git" ]; then
    log "fetching llvm-project $LLVM_REV (compiler-rt builtins only)"
    rm -rf "$W64/llvm-project" && git init -q "$W64/llvm-project"
    ( cd "$W64/llvm-project" && git remote add origin https://github.com/llvm/llvm-project \
      && git sparse-checkout set compiler-rt cmake llvm/cmake \
      && git fetch -q --depth 1 --filter=blob:none origin "$LLVM_REV" \
      && git checkout -q FETCH_HEAD )
  fi
  log "building compiler-rt builtins for wasm64-wasip2"
  rm -rf "$W64/rt64"
  cmake -G Ninja -S "$W64/llvm-project/compiler-rt/lib/builtins" -B "$W64/rt64" \
    -DLLVM_MAIN_SRC_DIR="$W64/llvm-project/llvm" \
    -DCMAKE_SYSTEM_NAME=WASI -DCMAKE_SYSTEM_PROCESSOR=wasm64 \
    -DCMAKE_C_COMPILER="$CLANG" -DCMAKE_C_COMPILER_TARGET=wasm64-unknown-wasip2 \
    -DCMAKE_AR="$AR" -DCMAKE_NM="$W64/wasi-sdk/bin/llvm-nm" \
    -DCMAKE_RANLIB="$W64/wasi-sdk/bin/llvm-ranlib" \
    -DCMAKE_C_FLAGS="--sysroot=$W64/sysroot64 -O2" \
    -DCMAKE_C_COMPILER_WORKS=ON -DCMAKE_SIZEOF_VOID_P=8 \
    -DCOMPILER_RT_BAREMETAL_BUILD=ON -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
    -DCOMPILER_RT_OS_DIR=wasm64-unknown-wasip2 \
    -DCOMPILER_RT_INCLUDE_TESTS=OFF -DCOMPILER_RT_HAS_FPIC_FLAG=OFF >/dev/null
  ninja -C "$W64/rt64" >/dev/null
  mkdir -p "$RTDIR"
  install -m644 "$W64/rt64/lib/wasm64-unknown-wasip2/libclang_rt.builtins-wasm64.a" \
    "$RTDIR/libclang_rt.builtins.a"
  rm -rf "$W64/rt64"
fi

# 3. wasm-tools v1.256.0 + the memory64 component encoder
if [ ! -x "$W64/wasm-tools" ]; then
  if [ ! -d "$W64/wasm-tools-src/.git" ]; then
    log "fetching wasm-tools v1.256.0"
    rm -rf "$W64/wasm-tools-src"
    git clone -q --depth 1 --branch v1.256.0 https://github.com/bytecodealliance/wasm-tools "$W64/wasm-tools-src"
    ( cd "$W64/wasm-tools-src" && git apply --check "$P/wit-component-memory64.patch" && git apply "$P/wit-component-memory64.patch" )
  fi
  log "building wasm-tools"
  ( cd "$W64/wasm-tools-src" && cargo "+$RUST_TC" build --release -q 2>/dev/null || cargo "+$RUST_TC" build --release )
  cp "$W64/wasm-tools-src/target/release/wasm-tools" "$W64/wasm-tools"
fi

# 4. wac at the commit the patch was cut against, on the 0.256 crates
WAC_REV="${WAC_REV:-49bab231a5a44bc9b3486df6d1ea5b9467c0bcaf}"
if [ ! -x "$W64/wac" ]; then
  if [ ! -d "$W64/wac-src/.git" ]; then
    log "fetching wac"
    rm -rf "$W64/wac-src" && git init -q "$W64/wac-src"
    ( cd "$W64/wac-src" && git remote add origin https://github.com/bytecodealliance/wac \
      && { git fetch -q --depth 1 origin "$WAC_REV" 2>/dev/null || git fetch -q --depth 50 origin main; } \
      && { git checkout -q FETCH_HEAD 2>/dev/null; git checkout -q "$WAC_REV" 2>/dev/null || true; } \
      && git apply --check "$P/wac-wasm-tools-0.256.patch" && git apply "$P/wac-wasm-tools-0.256.patch" )
  fi
  log "building wac ($STABLE)"
  ( cd "$W64/wac-src" && cargo $STABLE build --release -p wac-cli -q 2>/dev/null || cargo $STABLE build --release -p wac-cli )
  cp "$W64/wac-src/target/release/wac" "$W64/wac"
fi

# 5. the patched crates
if [ ! -f "$W64/wit-bindgen/.w64-patched" ]; then
  crate wit-bindgen 0.57.1 "$W64/wit-bindgen"
  ( cd "$W64/wit-bindgen" && patch -p1 -s < "$P/wit-bindgen-0.57.1-wasm64.patch" ) && touch "$W64/wit-bindgen/.w64-patched"
fi
if [ ! -f "$W64/wasip2/.w64-patched" ]; then
  crate wasip2 "1.0.4+wasi-0.2.12" "$W64/wasip2"   # the build metadata is part of the tarball name
  # the pregenerated bindings are already pointer-size aware; only the
  # `#[cfg(target_arch = "wasm32")]` gates (and their not() stubs) need widening
  find "$W64/wasip2/src" -name '*.rs' -exec sed -i 's/target_arch = "wasm32"/target_family = "wasm"/g' {} +
  touch "$W64/wasip2/.w64-patched"
fi
mkdir -p "$W64/crates"
for spec in "getrandom 0.2.17" "getrandom 0.4.3"; do
  set -- $spec
  d="$W64/crates/$1-$2"
  if [ ! -f "$d/.w64-patched" ]; then
    crate "$1" "$2" "$d"
    ( cd "$d" && patch -p1 -s < "$P/$1-$2-wasm64.patch" ) && touch "$d/.w64-patched"
  fi
done

# 6. std sources, widened, with the patched crates wired in
RUST_SRC="$(rustc "+$RUST_TC" --print sysroot)/lib/rustlib/src/rust/library"
if [ ! -f "$W64/rustsrc/library/Cargo.toml" ] || ! grep -q "$W64/wasip2" "$W64/rustsrc/library/Cargo.toml"; then
  log "copying std sources from $RUST_SRC"
  sh "$HERE/std-wasm64.sh" "$RUST_SRC" "$W64/rustsrc/library" "$W64"
fi

# 7. the WASI pass-through proxy (wasm32): the composition partner every
# memory64 component is plugged into. Built once here so a C publisher needs
# no Rust of their own.
if [ ! -f "$W64/wasiproxy.wasm" ]; then
  log "building the wasi pass-through proxy (wasm32-wasip2)"
  ( cd "$HERE/wasiproxy" && cargo "+$RUST_TC" build --release --target wasm32-wasip2 \
      --target-dir "$W64/wasiproxy-target" -q )
  cp "$W64/wasiproxy-target/wasm32-wasip2/release/wasiproxy.wasm" "$W64/wasiproxy.wasm"
fi

log "toolchain ready at $W64"
log "  clang:      $("$CLANG" --version | head -1)"
log "  wasm-tools: $("$W64/wasm-tools" --version)"
log "  wac:        $("$W64/wac" --version)"
log "  rustc:      $(rustc "+$RUST_TC" --version) ($RUST_TC)"
log "  proxy:      $W64/wasiproxy.wasm"
log ""
log "  build a C guest:    sh $HERE/build-c.sh app.c -o app.wasm"
log "  build a Rust guest: sh $HERE/build-rust.sh /path/to/crate -o app.wasm"
