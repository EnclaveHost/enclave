#!/usr/bin/env bash
# build-selftest-ref.sh -- cpu/selftest-ref.c for the phone (NDK clang, API 35, the payload's -march): out/selftest-ref.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; NDK="${ANDROID_HOME:-$HOME/Android/Sdk}/ndk/27.2.12479018"
CLANG="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang"
"$CLANG" -O2 -g -Wall -Wextra -march=armv8.2-a+dotprod -I"$HERE/payload" "$HERE/cpu/selftest-ref.c" "$HERE/payload/anchor_gguf.c" "$HERE/payload/anchor_pins.c" \
  -ldl -o "$HERE/out/selftest-ref" 2>&1 | grep -v "^$" || true
[ -x "$HERE/out/selftest-ref" ] && echo "out/selftest-ref: $(stat -c %s "$HERE/out/selftest-ref") bytes"
