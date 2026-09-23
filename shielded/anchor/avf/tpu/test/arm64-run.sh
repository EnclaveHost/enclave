#!/usr/bin/env bash
# arm64-run.sh -- the host arithmetic tests, cross-built with the FLAGS libggml-tpu.so ships with, run on the phone.
#
# tpu_corr.h, tpu_unmask_span.h and tpu_sample.h are host-tested on x86 by run-all.sh. "Bit-identical" is a property of
# the compiler build (FMA contraction, vectorisation), so the same checks must also pass with the production toolchain:
# NDK 27.2 clang, API 35, -O3 -march=armv8.2-a+dotprod, default -ffp-contract (build.sh, libggml-tpu.so). CPU only; no
# TPU, no model, no app. Each test's OWN exit code is recorded (a pipe through tail would report tail's).
#
#   tpu/test/arm64-run.sh [OUT]      default OUT = results/arm64t-<date>
set -uo pipefail
cd "$(dirname "$0")/../.."
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
CXX="$SDK/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android35-clang++"
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"
FLAGS=(-O3 -g -std=c++17 -march=armv8.2-a+dotprod -static-libstdc++ -Ipayload)
OUT="${1:-results/arm64t-$(date +%Y%m%d-%H%M)}"; mkdir -p "$OUT"
BIN="$(mktemp -d)"; trap 'rm -rf "$BIN"' EXIT
DEV=/data/local/tmp/arm64t
TESTS=(corr-order-test unmask-span-test sample-cover-test)

[ "$("$ADB" get-state 2>/dev/null)" = device ] || { echo "no device"; exit 2; }
for t in "${TESTS[@]}"; do "$CXX" "${FLAGS[@]}" "tpu/test/$t.cpp" -o "$BIN/$t" || { echo "build $t failed"; exit 3; }; done
{ echo "compiler: $("$CXX" --version | head -1)"; echo "flags: ${FLAGS[*]}"
  echo "source: $(git rev-parse HEAD)$(git diff --quiet -- payload tpu/test || echo ' +dirty')"
  echo "device: $("$ADB" shell getprop ro.product.model | tr -d '\r') $("$ADB" shell getprop ro.build.fingerprint | tr -d '\r')"
  for t in "${TESTS[@]}"; do sha256sum "$BIN/$t" | sed "s|$BIN/||"; done; } > "$OUT/BUILD.txt"
"$ADB" shell "rm -rf $DEV && mkdir -p $DEV" && "$ADB" push "$BIN/." tpu/test/e2b-geometry.txt "$DEV/" >/dev/null || { echo "push failed"; exit 4; }
for t in "${TESTS[@]}"; do
    arg=""; [ "$t" = sample-cover-test ] && arg=e2b-geometry.txt
    "$ADB" shell "cd $DEV && chmod 755 $t && ./$t $arg > $t.log 2>&1; echo rc=\$?" | tr -d '\r' > "$OUT/$t.rc"
    "$ADB" pull "$DEV/$t.log" "$OUT/$t.log" >/dev/null
    rc=$(sed -n 's/^rc=//p' "$OUT/$t.rc"); printf '%-20s rc=%s  %s\n' "$t" "${rc:-?}" "$(tail -1 "$OUT/$t.log")"
done | tee "$OUT/SUMMARY.txt"
"$ADB" shell "rm -rf $DEV"
grep -q 'rc=[^0]\|rc=?' "$OUT/SUMMARY.txt" && exit 1 || exit 0
