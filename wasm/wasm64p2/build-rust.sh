#!/bin/sh
# Build a Rust crate into a memory64 wasip2 COMPONENT — a guest that can
# address more than 4 GiB and still serves ports, sockets and HTTP.
#
#   build-rust.sh [CRATE_DIR] -o app.wasm [-- extra cargo args]
#
# What is different from an ordinary `cargo build --target wasm32-wasip2`:
#
#   * there is no wasm64-wasip2 target in rustc: wasm64-wasip2.json here is
#     the wasm32-wasip2 spec with a 64-bit arch/data-layout/pointer width and
#     `-mwasm64` for the linker; std is built from source (-Zbuild-std) out of
#     a COPY of rust-src widened for wasm64 (std-wasm64.sh);
#   * the libc is wasi-libc built for wasm64-wasip2 with the platform's
#     memory64 patch, installed as the target's self-contained sysroot;
#   * the wasip2 crate (std's wasi 0.2 bindings) stubs every import with
#     unreachable!() off wasm32, wit-bindgen ships a wasm32-only
#     cabi_realloc, and getrandom gates its WASI backend on wasm32 — all
#     three are patched copies, wired in by [patch.crates-io];
#   * rustc's linker stops at the core module (--skip-wit-component) because
#     its bundled encoder types every canonical pointer as i32; the patched
#     wasm-tools encodes instead;
#   * the result is plugged into the WASI pass-through proxy (see build-c.sh
#     for why the engine needs it).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
W64="${W64:-$HOME/.cache/enclave-w64}"
RUST_TC="${RUST_TC:-nightly}"
for need in "$W64/wasi-sdk/bin/clang" "$W64/sysroot64/lib/wasm64-wasip2/libc.a" \
            "$W64/wasm-tools" "$W64/wac" "$W64/wasiproxy.wasm" \
            "$W64/rustsrc/library/Cargo.toml" "$W64/wit-bindgen/build.rs" \
            "$W64/wasip2/Cargo.toml" "$W64/crates/getrandom-0.2.17/Cargo.toml"; do
  [ -e "$need" ] || { echo "[w64] missing $need — run prepare-toolchain.sh first"; exit 2; }
done

CRATE="."; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "[w64] unknown flag $1"; exit 2 ;;
    *) CRATE="$1"; shift ;;
  esac
done
[ -n "$OUT" ] || { echo "[w64] -o OUTPUT.wasm is required"; exit 2; }
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT";; esac
cd "$CRATE"

# The self-contained sysroot rustc links for a custom target lives under the
# toolchain's rustlib/<target-name>/lib/self-contained. Point it at ours.
SC="$(rustc "+$RUST_TC" --print sysroot)/lib/rustlib/wasm64-wasip2/lib/self-contained"
mkdir -p "$SC"
for f in crt1-command.o crt1-reactor.o crt1.o libc.a; do
  ln -sf "$W64/sysroot64/lib/wasm64-wasip2/$f" "$SC/$f"
done
[ -f "$SC/libunwind.a" ] || "$W64/wasi-sdk/bin/llvm-ar" rcs "$SC/libunwind.a"

# The [patch] entries below re-resolve the graph and cargo writes that
# resolution back to Cargo.lock; a later wasm32 build would flip it back.
# Keep the crate's lock exactly as it was.
if [ -f Cargo.lock ]; then
  cp Cargo.lock "${TMPDIR:-/tmp}/w64-Cargo.lock.$$"
  trap 'cp "${TMPDIR:-/tmp}/w64-Cargo.lock.$$" Cargo.lock; rm -f "${TMPDIR:-/tmp}/w64-Cargo.lock.$$"' EXIT
fi

echo "[w64] building the core module (std from source, wasm64-wasip2)"
__CARGO_TESTS_ONLY_SRC_ROOT="$W64/rustsrc/library" \
WASM64_AR="$W64/wasi-sdk/bin/llvm-ar" WASM64_CLANG="$W64/wasi-sdk/bin/clang" \
RBX_CLANG="$W64/wasi-sdk/bin/clang" RBX_AR="$W64/wasi-sdk/bin/llvm-ar" \
RUSTFLAGS="-C link-arg=--skip-wit-component ${RUSTFLAGS:-}" \
  cargo "+$RUST_TC" build --release -Zbuild-std=std,panic_abort -Zjson-target-spec \
    --target "$HERE/wasm64-wasip2.json" \
    --config "patch.crates-io.wit-bindgen.path='$W64/wit-bindgen'" \
    --config "patch.crates-io.wasip2.path='$W64/wasip2'" \
    --config "patch.crates-io.getrandom2.path='$W64/crates/getrandom-0.2.17'" \
    --config "patch.crates-io.getrandom2.package='getrandom'" \
    --config "patch.crates-io.getrandom4.path='$W64/crates/getrandom-0.4.3'" \
    --config "patch.crates-io.getrandom4.package='getrandom'" \
    "$@"

CORE="$(ls -t target/wasm64-wasip2/release/*.wasm 2>/dev/null | head -1)"
[ -n "$CORE" ] || { echo "[w64] no core module under target/wasm64-wasip2/release"; exit 1; }

echo "[w64] encoding the component"
TMP="$(mktemp -d)"
"$W64/wasm-tools" component new "$CORE" -o "$TMP/raw.wasm"

echo "[w64] plugging it into the wasi pass-through proxy"
"$W64/wac" plug --plug "$W64/wasiproxy.wasm" "$TMP/raw.wasm" -o "$OUT"
"$W64/wasm-tools" validate --features all "$OUT"
python3 - "$OUT" "$W64/wasiproxy.wasm" "$W64/wasm-tools" <<'PY'
import subprocess, sys, re
def imports(p):
    out = subprocess.run([sys.argv[3], "component", "wit", p], capture_output=True, text=True, check=True).stdout
    return set(re.findall(r"^\s*import ([^;]+);", out, re.M))
stray = imports(sys.argv[1]) - imports(sys.argv[2])
assert not stray, f"imports bypass the proxy: {sorted(stray)}"
b = open(sys.argv[1], "rb").read()
assert b[:4] == b"\x00asm" and (b[6] | (b[7] << 8)) == 1, "not a component"
print(f"[w64] {sys.argv[1]}: {len(b):,} bytes, component, memory64, proxied")
PY
rm -rf "$TMP"
