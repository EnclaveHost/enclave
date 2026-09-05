#!/bin/sh
# Build C/C++ sources into a memory64 wasip2 COMPONENT — a guest that can
# address more than 4 GiB and still serves ports, sockets and HTTP.
#
#   build-c.sh app.c [more.c ...] [clang flags ...] -o app.wasm
#
# Three steps, because a stock clang cannot finish the job on its own:
#
#   1. clang --target=wasm64-wasip2 against the mem64-marshalled sysroot,
#      stopping at the CORE module (--skip-wit-component). Clang's bundled
#      component encoder types every canonical pointer as i32 and refuses a
#      64-bit memory outright ("type mismatch for function `poll`: expected
#      [I32, I32, I32] but found [I64, I64, I64]").
#   2. the patched wasm-tools encodes the component, following the core
#      module's memory width instead of assuming 32.
#   3. wac plugs the result into the WASI pass-through proxy. The engine
#      (wasmtime 49) runs memory64 components, but its HOST-side typed
#      canonical ABI still reads pointers and lengths as 32 bits; its
#      component-to-component adapters transcode properly, so the app talks
#      to a wasm32 component and only that component talks to the host.
#
# The output is what you publish: the publish path stamps `mem64: true` from
# the bytes and claim routing keeps it on engines that can parse a 64-bit
# memory. The ceiling lifts from the 4 GiB wasm32 clamp to the deployment's
# full RAM slice.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
W64="${W64:-$HOME/.cache/enclave-w64}"
for need in "$W64/wasi-sdk/bin/clang" "$W64/sysroot64/lib/wasm64-wasip2/libc.a" \
            "$W64/wasm-tools" "$W64/wac"; do
  [ -e "$need" ] || { echo "[w64] missing $need — run prepare-toolchain.sh first"; exit 2; }
done

# pull -o out of the arguments, keeping every other one in order and quoted
OUT=""
count=$#
while [ $count -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2; count=$((count - 2)); continue ;;
    -o*) OUT="${1#-o}"; shift; count=$((count - 1)); continue ;;
  esac
  set -- "$@" "$1"; shift; count=$((count - 1))
done
[ -n "$OUT" ] || { echo "[w64] -o OUTPUT.wasm is required"; exit 2; }
[ $# -gt 0 ] || { echo "[w64] no input files"; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "[w64] compiling the core module (wasm64-wasip2)"
"$W64/wasi-sdk/bin/clang" --target=wasm64-wasip2 --sysroot="$W64/sysroot64" \
  -Wl,--skip-wit-component "$@" -o "$TMP/core.wasm"

echo "[w64] encoding the component"
"$W64/wasm-tools" component new "$TMP/core.wasm" -o "$TMP/raw.wasm"

echo "[w64] building and composing the app-specific WASI proxy"
python3 "$HERE/proxy-app.py" "$TMP/raw.wasm" -o "$OUT"
