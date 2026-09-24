#!/usr/bin/env bash
# build.sh -- one APK carrying a payload for an AVF protected VM.
#
#   ./build.sh attest_probe         # the RKP attestation probe
#   ./build.sh anchor               # the anchor itself (core + simd + field)
#   ./build.sh sink                 # host-side vsock sink for --debug none runs
#   ./build.sh probe                # the complete trusted half + shielded-probe, static, for the phone
#   ./build.sh engine               # libggml-shielded.so + ggml-test + shielded-run for the phone (see build-ggml-arm64.sh)
#   ./build.sh engine-pvm           # the VM-side engine: libengine.so, liblocalengine.so, libggml-tpu.so
#   ANCHOR_TIER=pvm-cpu ./build.sh anchor   # the pVM CPU product build (PVM-CPU.md): out/anchor-pvm-cpu.apk, CPU engine only
#
# The VM-side libraries are built ONLY by engine-pvm; `anchor` packages what it finds and now REFUSES if a
# source is newer than its library. A run that touches the TPU worker needs both, in order, and the worker
# libraries named:   ./build.sh engine-pvm && ANCHOR_TPU_LIBS=<dir> ./build.sh anchor
# Without ANCHOR_TPU_LIBS the APK builds and installs happily and then fails at run time with
# "TPU worker library not in this APK".
#
# Produces out/<name>.apk, signed with keys/anchor.jks. Then, on the device:
#   vm create-idsig <apk> <idsig>
#   vm run-app --payload-binary-name lib<name>.so --protected [--debug none] ...
#
# The payload is a bionic .so with DT_NEEDED libvm_payload.so. That library
# exists only inside Microdroid, so we link against a STUB generated from
# AOSP's symbol map (libvm_payload.map.txt): empty functions with the right
# names, enough for the linker, never shipped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME="${1:-attest_probe}"
SDK="${ANDROID_HOME:-$HOME/Android/Sdk}"
NDK="$SDK/ndk/27.2.12479018"
BT="$SDK/build-tools/35.0.0"
API=35
CLANG="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android${API}-clang"
HDR="${AVF_HDR:-$HERE}"          # $HDR/avfref/{vm_payload.h,libvm_payload.map.txt}: vendored from AOSP (avfref/NOTICE)
GG="$HERE/../../../wasm/ggml-shielded"
CORE="$HERE/../core"
# ANCHOR_TIER: "research" (default: the combined build -- local, split engine, the closed TPU lane) or "pvm-cpu" (PVM-CPU.md:
# the payload + the CPU engine and nothing else; its own stage, APK name, manifest and therefore its own codeHash).
TIER="${ANCHOR_TIER:-research}"
case "$TIER" in research) SUFFIX="" ;; pvm-cpu) [ "$NAME" = anchor ] || { echo "ANCHOR_TIER=pvm-cpu builds the anchor only" >&2; exit 2; }; SUFFIX="-pvm-cpu" ;;
  *) echo "ANCHOR_TIER must be research or pvm-cpu" >&2; exit 2 ;; esac
OUT="$HERE/out"; STUB="$OUT/stub"; STAGE="$OUT/stage-$NAME$SUFFIX"
mkdir -p "$STUB" "$STAGE/lib/arm64-v8a" "$STAGE/assets"

# The APK signing key is the payload's identity to a verifier (its SHA-512 is the
# attested authorityHash). It is generated locally and never committed; a real
# deployment replaces it with a key held in the platform certificate service.
KS="$HERE/keys/anchor.jks"
if [ ! -f "$KS" ]; then
  mkdir -p "$HERE/keys"
  keytool -genkeypair -keystore "$KS" -storepass anchor123 -keypass anchor123 -alias anchor \
    -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Enclave Anchor Spike, O=Enclave Host" >/dev/null 2>&1
  echo "generated spike signing key $KS"
fi

for t in "$CLANG" "$BT/aapt2" "$BT/apksigner" "$BT/zipalign" "$SDK/platforms/android-$API/android.jar"; do
  [ -e "$t" ] || { echo "missing: $t" >&2; exit 2; }
done

# --- 1. stub libvm_payload.so from the symbol map -------------------------
if [ ! -f "$STUB/libvm_payload.so" ]; then
  MAP="$HDR/avfref/libvm_payload.map.txt"
  { echo '/* generated: link-time stub for Microdroid libvm_payload.so */';
    grep -oE 'AVm[A-Za-z_]+' "$MAP" | sort -u | while read -r s; do echo "void $s(void) {}"; done; } > "$STUB/stub.c"
  "$CLANG" -shared -fPIC -o "$STUB/libvm_payload.so" -Wl,-soname,libvm_payload.so "$STUB/stub.c"
  echo "stub: $(grep -c '^void' "$STUB/stub.c") symbols"
fi

# --- 2. the payload .so -----------------------------------------------------
CFLAGS=(-O2 -g -fPIC -Wall -march=armv8.2-a+dotprod -I"$HDR/avfref" -I"$CORE" -I"$GG")
case "$NAME" in
  sink)  # the host side of a --debug none VM's vsock report channel (static, runs from adb shell)
         "$CLANG" -O2 -static -Wall -o "$OUT/vsock-sink" "$HERE/host/vsock-sink.c"
         echo "sink: $OUT/vsock-sink ($(stat -c %s "$OUT/vsock-sink") bytes)"; exit 0 ;;
  probe)  # the COMPLETE trusted half (shielded-tee.c, not the anchor subset) + its probe, for the phone
         # itself: proves the file builds on bionic/aarch64 and that the NEON SDOT table agrees with
         # the generic one on this silicon (sh_simd_get runs simd_agree and prints the loser).
         PF=(-O2 -Wall -march=armv8.2-a+dotprod -I"$GG")
         "$CLANG" "${PF[@]}" -O3 -DSH_SIMD_NEON -c "$GG/shielded-simd.c" -o "$OUT/simd-neon.o"
         "$CLANG" "${PF[@]}" -O3 -c "$GG/shielded-simd.c" -o "$OUT/simd-generic.o"
         "$CLANG" "${PF[@]}" -ffp-contract=off -c "$GG/shielded-field.c" -o "$OUT/field.o"
         "$CLANG" "${PF[@]}" -c "$GG/shielded-wire.c" -o "$OUT/wire.o"
         "$CLANG" "${PF[@]}" -c "$GG/shielded-parwork.c" -o "$OUT/parwork.o"   # shielded-tee.c calls sh_par_for unconditionally
         "$CLANG" "${PF[@]}" -c "$GG/shielded-tee.c" -o "$OUT/tee.o"
         "$CLANG" "${PF[@]}" -c "$GG/shielded-pads.c" -o "$OUT/pads.o"      # dealt pads (shielded/dealer/PLAN.md)
         "$CLANG" "${PF[@]}" -c "$GG/shielded-bank.c" -o "$OUT/bank.o"; "$CLANG" "${PF[@]}" -c "$GG/shielded-http.c" -o "$OUT/http.o"; "$CLANG" "${PF[@]}" -c "$GG/prefix-kv.c" -o "$OUT/prefixkv.o"
         "$CLANG" "${PF[@]}" -w -c "$GG/tweetnacl.c" -o "$OUT/nacl.o"
         "$CLANG" "${PF[@]}" -O3 -w -c "$GG/poly1305-donna.c" -o "$OUT/poly.o"
         "$CLANG" "${PF[@]}" -static -o "$OUT/shielded-probe" "$GG/shielded-probe.c" "$OUT/tee.o" "$OUT/parwork.o" "$OUT/pads.o" "$OUT/bank.o" "$OUT/http.o" "$OUT/prefixkv.o" "$OUT/nacl.o" "$OUT/poly.o" "$OUT/field.o" "$OUT/wire.o" "$OUT/simd-neon.o" "$OUT/simd-generic.o" -lm
         printf '#include "shielded-simd.h"\n#include <stdio.h>\nint main(void){printf("simd=%%s\\n", sh_simd_get()->name);return 0;}\n' > "$OUT/simd-check.c"
         "$CLANG" "${PF[@]}" -static -o "$OUT/simd-check" "$OUT/simd-check.c" "$OUT/tee.o" "$OUT/parwork.o" "$OUT/pads.o" "$OUT/bank.o" "$OUT/http.o" "$OUT/prefixkv.o" "$OUT/nacl.o" "$OUT/poly.o" "$OUT/field.o" "$OUT/wire.o" "$OUT/simd-neon.o" "$OUT/simd-generic.o" -lm
         echo "probe: $OUT/shielded-probe ($(stat -c %s "$OUT/shielded-probe") bytes), simd-check"; exit 0 ;;
  engine)  # the COMPLETE engine for the phone, normal world: libggml-shielded.so (the backend module),
           # ggml-test and shielded-run, against the arm64 llama.cpp from build-ggml-arm64.sh.
           #   GGML_ARM64=<prefix dir>   default out/ggml-arm64-work/prefix
           # Run on the device with LD_LIBRARY_PATH=<dir> SHIELDED_SO=<dir>/libggml-shielded.so
           #   GGML_CPU_SO=<dir>/libggml-cpu.so SHIELDED_HOST/PORT/CALIB (REPORT.md section 12).
           GA="${GGML_ARM64:-$HERE/out/ggml-arm64-work/prefix}"; LSRC="$(dirname "$GA")/llama.cpp"
           [ -d "$GA/lib" ] || { echo "no arm64 llama.cpp at $GA; run build-ggml-arm64.sh first" >&2; exit 2; }
           CXX="${CLANG}++"; INC=(-I"$LSRC/include" -I"$LSRC/ggml/include" -I"$LSRC/ggml/src"); E="$OUT/engine"; mkdir -p "$E"
           PF=(-O2 -g -fPIC -march=armv8.2-a+dotprod -I"$GG")
           "$CLANG" "${PF[@]}" -O3 -DSH_SIMD_NEON -c "$GG/shielded-simd.c" -o "$E/simd-neon.o"
           "$CLANG" "${PF[@]}" -O3 -c "$GG/shielded-simd.c" -o "$E/simd-generic.o"
           "$CLANG" "${PF[@]}" -ffp-contract=off -c "$GG/shielded-field.c" -o "$E/field.o"
           "$CLANG" "${PF[@]}" -c "$GG/shielded-wire.c" -o "$E/wire.o"
           "$CLANG" "${PF[@]}" -c "$GG/shielded-parwork.c" -o "$E/parwork.o"   # shielded-tee.c calls sh_par_for unconditionally
           "$CLANG" "${PF[@]}" -c "$GG/shielded-tee.c" -o "$E/tee.o"
           "$CLANG" "${PF[@]}" -c "$GG/shielded-pads.c" -o "$E/pads.o"      # dealt pads (shielded/dealer/PLAN.md)
           "$CLANG" "${PF[@]}" -c "$GG/shielded-bank.c" -o "$E/bank.o"; "$CLANG" "${PF[@]}" -c "$GG/shielded-http.c" -o "$E/http.o"; "$CLANG" "${PF[@]}" -c "$GG/prefix-kv.c" -o "$E/prefixkv.o"
           "$CLANG" "${PF[@]}" -w -c "$GG/tweetnacl.c" -o "$E/nacl.o"
           "$CLANG" "${PF[@]}" -O3 -w -c "$GG/poly1305-donna.c" -o "$E/poly.o"
           CORE=("$E/tee.o" "$E/parwork.o" "$E/pads.o" "$E/bank.o" "$E/http.o" "$E/prefixkv.o" "$E/nacl.o" "$E/poly.o" "$E/field.o" "$E/wire.o" "$E/simd-neon.o" "$E/simd-generic.o")
           "$CXX" -O2 -g -std=c++17 -fPIC -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 -DGGML_BACKEND_DL -DGGML_BACKEND_SHARED "${INC[@]}" -I"$GG" -c "$GG/ggml-shielded.cpp" -o "$E/ggml-shielded-dl.o"
           # bionic does not resolve a dlopened module's symbols against the executable's other libraries: link libggml too
           "$CXX" -shared -o "$E/libggml-shielded.so" "$E/ggml-shielded-dl.o" "${CORE[@]}" -L"$GA/lib" -lggml -lggml-base -lm
           "$CXX" -O2 -g -std=c++17 -fPIC -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 "${INC[@]}" -I"$GG" -c "$GG/ggml-shielded.cpp" -o "$E/ggml-shielded.o"
           "$CXX" -O2 -g -std=c++17 -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 "${INC[@]}" -I"$GG" -o "$E/ggml-test" "$GG/ggml-test.cpp" "$E/ggml-shielded.o" "${CORE[@]}" -L"$GA/lib" -lggml -lggml-base -lggml-cpu -lm
           "$CXX" -O2 -g -std=c++17 -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 "${INC[@]}" -I"$GG" -o "$E/shielded-run" "$GG/shielded-run.cpp" "${CORE[@]}" -L"$GA/lib" -lllama -lggml -lggml-base -ldl -lm
           cp "$GA"/lib/libllama.so "$GA"/lib/libggml.so "$GA"/lib/libggml-base.so "$GA"/lib/libggml-cpu.so "$GA"/lib/libc++_shared.so "$GG/test.calib" "$E/"
           echo "engine: $E (push the directory to the phone)"; ls "$E" | grep -vE '\.o$' | tr '\n' ' '; echo; exit 0 ;;
  engine-pvm)  # the engine FOR THE VM: the shielded module with the fd-adopting hook, and libengine.so
           #   (shielded-run's flow, model from a memfd, worker fd adopted). Both are dlopened by the
           #   bootstrap payload from the APK, so libengine.so may carry ordinary DT_NEEDED on llama/ggml.
           GA="${GGML_ARM64:-$HERE/out/ggml-arm64-work/prefix}"; LSRC="$(dirname "$GA")/llama.cpp"
           [ -d "$GA/lib" ] || { echo "no arm64 llama.cpp at $GA; run build-ggml-arm64.sh first" >&2; exit 2; }
           CXX="${CLANG}++"; INC=(-I"$LSRC/include" -I"$LSRC/ggml/include" -I"$LSRC/ggml/src"); E="$OUT/engine-pvm"; mkdir -p "$E"
           PF=(-O2 -g -fPIC -march=armv8.2-a+dotprod -I"$GG" -I"$HERE/../harness")
           "$CLANG" "${PF[@]}" -O3 -DSH_SIMD_NEON -c "$GG/shielded-simd.c" -o "$E/simd-neon.o"
           "$CLANG" "${PF[@]}" -O3 -DSH_SIMD_NEON -DSH_SIMD_NEON_TUNED -c "$GG/shielded-simd.c" -o "$E/simd-neon-tuned.o"
           "$CLANG" "${PF[@]}" -O3 -c "$GG/shielded-simd.c" -o "$E/simd-generic.o"
           "$CLANG" "${PF[@]}" -ffp-contract=off -c "$GG/shielded-field.c" -o "$E/field.o"
           "$CLANG" "${PF[@]}" -c "$HERE/../harness/wire-fd.c" -o "$E/wire-fd.o"                       # shielded-wire.c + sh_pipe_open_fd + the hook
           "$CLANG" "${PF[@]}" -DSH_HAVE_NEON_TUNED -c "$GG/shielded-parwork.c" -o "$E/parwork.o"   # shielded-tee.c calls sh_par_for unconditionally
           "$CLANG" "${PF[@]}" -DSH_HAVE_NEON_TUNED -Dsh_pipe_open=sh_pipe_open_hook -c "$GG/shielded-tee.c" -o "$E/tee.o"    # the trusted half dials through the hook
           "$CLANG" "${PF[@]}" -c "$GG/shielded-pads.c" -o "$E/pads.o"      # dealt pads (shielded/dealer/PLAN.md)
           "$CLANG" "${PF[@]}" -c "$GG/shielded-bank.c" -o "$E/bank.o"; "$CLANG" "${PF[@]}" -c "$GG/shielded-http.c" -o "$E/http.o"; "$CLANG" "${PF[@]}" -c "$GG/prefix-kv.c" -o "$E/prefixkv.o"
           "$CLANG" "${PF[@]}" -w -c "$GG/tweetnacl.c" -o "$E/nacl.o"
           "$CLANG" "${PF[@]}" -O3 -w -c "$GG/poly1305-donna.c" -o "$E/poly.o"
           "$CXX" -O2 -g -std=c++17 -fPIC -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 -DGGML_BACKEND_DL -DGGML_BACKEND_SHARED "${INC[@]}" -I"$GG" -c "$GG/ggml-shielded.cpp" -o "$E/ggml-shielded-dl.o"
           "$CXX" -shared -o "$E/libggml-shielded.so" "$E/ggml-shielded-dl.o" "$E/tee.o" "$E/parwork.o" "$E/pads.o" "$E/bank.o" "$E/http.o" "$E/prefixkv.o" "$E/nacl.o" "$E/poly.o" "$E/field.o" "$E/wire-fd.o" "$E/simd-neon.o" "$E/simd-neon-tuned.o" "$E/simd-generic.o" -L"$GA/lib" -lggml -lggml-base -lm -Wl,-soname,libggml-shielded.so
           "$CLANG" "${PF[@]}" -D_GNU_SOURCE "${INC[@]}" -c "$HERE/payload/anchor_mtp.c" -o "$E/mtp.o"   # the MTP head as the draft model
           "$CXX" -O2 -g -std=c++17 -fPIC -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 "${INC[@]}" -I"$GG" -I"$HERE/payload" -I"$LSRC/src" -shared -o "$E/libengine.so" "$HERE/payload/engine.cpp" "$E/mtp.o" "$E/pads.o" "$E/bank.o" "$E/http.o" "$E/prefixkv.o" "$E/nacl.o" "$E/poly.o" -L"$GA/lib" -lllama -lggml -lggml-base -llog -ldl -Wl,-soname,libengine.so
           # the LOCAL engine (payload/engine_local.cpp, LOCAL.md): the whole model in the VM, CPU only. Same llama/ggml as above;
           # its CPU module is the REPACKING build (GGML_CPU_REPACK=ON ./build-ggml-arm64.sh "$PWD/out/ggml-arm64-repack-work": the work dir must be absolute), bundled as libggml-cpu-repack.so
           # speculative rows use llama.cpp's own helper (common/speculative.cpp): libllama-common.so from the repack work tree
           #   (cmake -B build-android-common ... -DLLAMA_BUILD_COMMON=ON -DCMAKE_POSITION_INDEPENDENT_CODE=ON; --target llama-common: LOCAL.md)
           GRC="${GGML_ARM64_REPACK_SRC:-$HERE/out/ggml-arm64-repack-work/llama.cpp}"; [ -f "$GRC/build-android-common/bin/libllama-common.so" ] || { echo "no libllama-common.so under $GRC/build-android-common (LOCAL.md)" >&2; exit 2; }
           cp "$GRC/build-android-common/bin/libllama-common.so" "$E/libllama-common.so"
           "$CXX" -O2 -g -std=c++17 -fPIC -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 "${INC[@]}" -I"$HERE/payload" -I"$LSRC/src" -I"$LSRC/common" -I"$LSRC/vendor" -shared -o "$E/liblocalengine.so" "$HERE/payload/engine_local.cpp" -L"$GA/lib" -L"$E" -lllama-common -lllama -lggml -lggml-base -llog -ldl -Wl,-soname,liblocalengine.so
           # Shielded-TPU decode (payload/ggml-tpu.cpp, TPU.md): the VM-side backend module, loaded by the local engine on request
           "$CXX" -O3 -g -std=c++17 -fPIC -march=armv8.2-a+dotprod -DGGML_MAX_NAME=128 -DGGML_BACKEND_DL -DGGML_BACKEND_SHARED "${INC[@]}" -I"$HERE/payload" -shared -o "$E/libggml-tpu.so" "$HERE/payload/ggml-tpu.cpp" -L"$GA/lib" -lggml -lggml-base -lm -Wl,-soname,libggml-tpu.so
           "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm" -D "$E/liblocalengine.so" | grep -E ' T engine_local_(main|set_model_table|set_ctl_writer)$' | sed 's/^/  /'
           "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-nm" -D "$E/libggml-shielded.so" | grep -E ' T (sh_pipe_adopt_fd|sh_pipe_open_hook|ggml_backend_shielded_stats)$' | sed 's/^/  /'
           echo "engine-pvm: $E/libggml-shielded.so ($(stat -c %s "$E/libggml-shielded.so") B), libengine.so ($(stat -c %s "$E/libengine.so") B)"; exit 0 ;;
  attest_probe) SRCS=("$HERE/payload/attest_probe.c") ;;
  jit_probe)    SRCS=("$HERE/payload/jit_probe.c") ;;   # can the pVM payload JIT? (W^X executable pages; PVM-CPU.md, portable runtime)
  rt_probe)     # the portable runtime (runtime/pvm-rt, built for aarch64-linux-android) running the conformance vectors inside the pVM
                SRCS=("$HERE/payload/rt_probe.c"); EXTRA_LIBS=("${PVM_RT_LIB:-$HERE/out/pvm-rt-target/aarch64-linux-android/release/libpvm_rt.so}")
                [ -f "${EXTRA_LIBS[0]}" ] || { echo "rt_probe: build runtime/pvm-rt for aarch64-linux-android first" >&2; exit 2; }
                RT_ASSETS=("$HERE/runtime/conformance/bundles/hello-v1.wasm:conformance-hello-v1.wasm") ;;
  pvm_probe)    SRCS=("$HERE/payload/pvm_probe.c"); EXTRA_LIBS=("$HOME/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "${GGML_ARM64:-$HERE/out/ggml-arm64-work/prefix}/lib/libggml-base.so" "${GGML_ARM64:-$HERE/out/ggml-arm64-work/prefix}/lib/libggml.so") ;;
  anchor)       # the anchor + the harness's worker client over an fd (wire-fd.c wraps the shipped shielded-wire.c).
                # shielded-simd.c is built twice, generic and -DSH_SIMD_NEON; the core's refill is pointed at SDOT.
                "$CLANG" -O3 -fPIC -march=armv8.2-a+dotprod -DSH_SIMD_NEON -I"$GG" -c "$GG/shielded-simd.c" -o "$OUT/simd-neon-pic.o"
                SRCS=("$HERE/payload/anchor_payload.c" "$HERE/payload/anchor_pins.c" "$HERE/payload/anchor_names.c" "$HERE/payload/anchor_gguf.c" "$HERE/payload/anchor_catalog.c" "$HERE/payload/anchor_encoded_catalog.c" "$HERE/payload/anchor_artifacts.c" "$HERE/payload/anchor_auth.c" "$HERE/payload/anchor_prepare.c" "$HERE/payload/anchor_rxctl.c" "$HERE/payload/anchor_model_cache.c" "$HERE/payload/anchor_maskbench.c" "$HERE/payload/anchor_copy.c" "$CORE/anchor-core.c" "$GG/shielded-simd.c" "$GG/shielded-field.c"
                      "$HERE/../harness/worker-client.c" "$HERE/../harness/wire-fd.c" "$GG/shielded-pads.c" "$GG/shielded-bank.c" "$GG/shielded-http.c" "$GG/prefix-kv.c" "$GG/poly1305-donna.c"
                      "$HERE/payload/third_party/tweetnacl.c" "$OUT/simd-neon-pic.o")
                CFLAGS+=(-ffp-contract=off -I"$HERE/../harness" -DAN_REFILL=sh_simd_neon_refill)
                GA="${GGML_ARM64:-$HERE/out/ggml-arm64-work/prefix}"; GR="${GGML_ARM64_REPACK:-$HERE/out/ggml-arm64-repack-work/prefix}"
                if [ "$TIER" = pvm-cpu ]; then
                  # pVM CPU (PVM-CPU.md): the payload + the CPU engine, NOTHING else -- no split engine (libengine.so,
                  # libggml-shielded.so, model.calib), no TPU backend (libggml-tpu.so), no TPU worker or Tensor dispatch
                  # library. The payload is compiled with ANCHOR_TIER_PVM_CPU and refuses every mode but LOCAL.
                  [ -f "$OUT/engine-pvm/liblocalengine.so" ] && [ -f "$OUT/engine-pvm/libllama-common.so" ] && [ -f "$GR/lib/libggml-cpu.so" ] || {
                    echo "pvm-cpu: needs build.sh engine-pvm and GGML_CPU_REPACK=ON ./build-ggml-arm64.sh $HERE/out/ggml-arm64-repack-work" >&2; exit 2; }
                  [ "$HERE/payload/engine_local.cpp" -nt "$OUT/engine-pvm/liblocalengine.so" ] && { echo "STALE: payload/engine_local.cpp is newer than liblocalengine.so. Run ./build.sh engine-pvm first." >&2; exit 2; }
                  cp "$GR/lib/libggml-cpu.so" "$OUT/engine-pvm/libggml-cpu-repack.so"
                  EXTRA_LIBS=("$GA/lib/libc++_shared.so" "$GA/lib/libggml-base.so" "$GA/lib/libggml.so" "$GA/lib/libllama.so" "$OUT/engine-pvm/libllama-common.so"
                              "$OUT/engine-pvm/liblocalengine.so" "$OUT/engine-pvm/libggml-cpu-repack.so")
                  # the portable app runtime (runtime/pvm-rt, wasmtime -> Pulley; PVM-CPU.md "The app runtime"): the APP line runs a component with it
                  PVM_RT="${PVM_RT_LIB:-$HERE/out/pvm-rt-target/aarch64-linux-android/release/libpvm_rt.so}"
                  [ -f "$PVM_RT" ] || { echo "pvm-cpu: build runtime/pvm-rt for aarch64-linux-android first (libpvm_rt.so)" >&2; exit 2; }
                  EXTRA_LIBS+=("$PVM_RT")
                  CFLAGS+=(-DANCHOR_TIER_PVM_CPU)
                  echo "pvm-cpu: bundling the CPU engine only (${#EXTRA_LIBS[@]} libraries); no split engine, no TPU backend or worker"
                # the engine rides along when it has been built (build.sh engine-pvm): six libraries + the calibration
                elif [ -f "$OUT/engine-pvm/libengine.so" ]; then
                  EXTRA_LIBS=("$GA/lib/libc++_shared.so" "$GA/lib/libggml-base.so" "$GA/lib/libggml.so" "$GA/lib/libggml-cpu.so" "$GA/lib/libllama.so" "$OUT/engine-pvm/libggml-shielded.so" "$OUT/engine-pvm/libengine.so")
                  EXTRA_ASSETS=("${ANCHOR_CALIB:-$HERE/../../../metal/shielded-overlay/calib/qwen3.5-0.8b-mtp-gguf.calib}")
                  echo "engine: bundling ${#EXTRA_LIBS[@]} libraries + $(basename "${EXTRA_ASSETS[0]}") as assets/model.calib"
                  # the local engine rides along when both of its pieces exist: liblocalengine.so and the repacking CPU module
                  if [ -f "$OUT/engine-pvm/liblocalengine.so" ] && [ -f "$GR/lib/libggml-cpu.so" ]; then
                    cp "$GR/lib/libggml-cpu.so" "$OUT/engine-pvm/libggml-cpu-repack.so"
                    # STALENESS GUARD. These libraries are built by `build.sh engine-pvm`, NOT here: editing
                    # payload/ggml-tpu.cpp or engine_local.cpp and running `build.sh anchor` used to package the
                    # PREVIOUS binary without a word. That shipped a fault-injection build into a measurement run
                    # once already, and only the payload's self-attested "build config" line caught it. Refuse.
                    # The headers the two compile in count too: tpu_corr.h / tpu_unmask_span.h / tpu_sample.h hold the
                    # correction, unmask and sampler bodies, and an edit there alone would ship the old library.
                    for pair in "libggml-tpu.so:payload/ggml-tpu.cpp" "libggml-tpu.so:payload/ggml-tpu.h" "libggml-tpu.so:payload/tpu_corr.h" \
                                "libggml-tpu.so:payload/tpu_unmask_span.h" "libggml-tpu.so:payload/tpu_sample.h" \
                                "liblocalengine.so:payload/engine_local.cpp" "liblocalengine.so:payload/ggml-tpu.h"; do
                      lib="$OUT/engine-pvm/${pair%%:*}"; src="$HERE/${pair##*:}"
                      if [ "$src" -nt "$lib" ]; then
                        echo "STALE: $src is newer than ${pair%%:*}. Run ./build.sh engine-pvm first." >&2; exit 2; fi
                    done
                    EXTRA_LIBS+=("$OUT/engine-pvm/liblocalengine.so" "$OUT/engine-pvm/libggml-cpu-repack.so" "$OUT/engine-pvm/libggml-tpu.so" "$OUT/engine-pvm/libllama-common.so")
                    # the app-side (untrusted) TPU worker + LiteRT's Tensor dispatch library: prebuilt outside this repo (TPU.md), bundled when ANCHOR_TPU_LIBS names them
                    if [ -n "${ANCHOR_TPU_LIBS:-}" ] && [ -f "$ANCHOR_TPU_LIBS/libanchortpu.so" ] && [ -f "$ANCHOR_TPU_LIBS/libLiteRtDispatch_GoogleTensor.so" ]; then
                      EXTRA_LIBS+=("$ANCHOR_TPU_LIBS/libanchortpu.so" "$ANCHOR_TPU_LIBS/libLiteRtDispatch_GoogleTensor.so"); echo "tpu worker: bundling libanchortpu.so + the Tensor dispatch library from $ANCHOR_TPU_LIBS"
                    else echo "tpu worker: NOT bundled (set ANCHOR_TPU_LIBS to a dir holding libanchortpu.so and libLiteRtDispatch_GoogleTensor.so)"; fi
                    echo "local engine: bundling liblocalengine.so + libggml-cpu-repack.so (mode local, LOCAL.md)"
                  else echo "local engine: NOT bundled (needs build.sh engine-pvm and GGML_CPU_REPACK=ON ./build-ggml-arm64.sh "\$PWD/out/ggml-arm64-repack-work")"; fi
                fi ;;
  *) echo "unknown payload $NAME" >&2; exit 2 ;;
esac
rm -f "$STAGE"/lib/arm64-v8a/*.so
"$CLANG" "${CFLAGS[@]}" -shared -o "$STAGE/lib/arm64-v8a/lib$NAME.so" "${SRCS[@]}" \
   -L"$STUB" -lvm_payload -llog -lm -ldl -Wl,-soname,lib$NAME.so
for x in "${EXTRA_LIBS[@]:-}"; do [ -n "$x" ] && cp "$x" "$STAGE/lib/arm64-v8a/"; done
# App-side echo diagnostic; no libvm_payload dependency and no inference hook.
if [ "$NAME" = anchor ] && [ "$TIER" != pvm-cpu ]; then
  "$CLANG" -O2 -fPIC -shared -Wall -Wextra "$HERE/host/native-echo.c" -o "$STAGE/lib/arm64-v8a/libanchor-echo.so"
  "$CLANG" -O2 -fPIC -shared -Wall -Wextra "$HERE/host/native-bridge.c" -llog -o "$STAGE/lib/arm64-v8a/libanchor-bridge.so"   # opt-in native worker bridge (--ez nativebridge true)
fi
# stripped copies: the dynamic symbol table (what dlopen/dlsym need) stays, the rest of libllama's 40 MB goes
for x in "$STAGE"/lib/arm64-v8a/*.so; do "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" --strip-unneeded "$x"; done
for x in "${EXTRA_ASSETS[@]:-}"; do [ -n "$x" ] && cp "$x" "$STAGE/assets/model.calib"; done
rm -f "$STAGE"/assets/conformance-*
for x in "${RT_ASSETS[@]:-}"; do [ -n "$x" ] || continue; src="${x%%:*}"; dst="${x##*:}"   # the bundle + its pin (measured with the APK)
  cp "$src" "$STAGE/assets/$dst"; sha256sum "$src" | cut -c1-64 > "$STAGE/assets/${dst%.wasm}.sha256"; done
# Measured pins (payload/anchor_pins.h): ANCHOR_MODE=dev|protected (default dev) is written to assets/anchor.mode;
# ANCHOR_LEDGER_PK, ANCHOR_MODEL_SHA256 and ANCHOR_PREFIX_PK name files holding 64 hex each and land as
# assets/ledger.pk, model.sha256, prefix.pk. A protected build refuses to package without all three.
MODE="${ANCHOR_MODE:-dev}"; case "$MODE" in dev|protected) ;; *) echo "ANCHOR_MODE must be dev or protected" >&2; exit 2;; esac
printf '%s\n' "$MODE" > "$STAGE/assets/anchor.mode"
printf '%s\n' "$TIER" > "$STAGE/assets/tier"   # measured with the APK (codeHash): the app shows the tier from it; the relay admits by codeHash
if [ "$TIER" = pvm-cpu ]; then for v in ANCHOR_LEDGER_PK ANCHOR_PREFIX_PK ANCHOR_SOURCE_CATALOG_SHA256 ANCHOR_ENCODED_CATALOG_SHA256 ANCHOR_CONVERTER_SHA256 ANCHOR_SOURCE_CATALOG ANCHOR_ENCODED_CATALOG ANCHOR_MASKBENCH_PADS; do
  [ -z "${!v:-}" ] || { echo "pvm-cpu: $v is split-engine machinery and is not packaged in this tier (the payload would refuse it)" >&2; exit 2; }; done; fi
# An unset variable REMOVES the staged pin: the stage directory persists between builds, and a dev build
# after a protected one must not inherit the other's pins (nor a protected build another model's).
pin() { local var="$1" file="$2"; local src="${!var:-}"; if [ -n "$src" ]; then [ -f "$src" ] || { echo "$var: $src not found" >&2; exit 2; }
        tr -d ' \n' < "$src" > "$STAGE/assets/$file"; [ "$(wc -c < "$STAGE/assets/$file")" = 64 ] || { echo "$var: $src is not 64 hex" >&2; exit 2; }; echo "pinned $file from $src"
        else rm -f "$STAGE/assets/$file"; fi; }
pin ANCHOR_LEDGER_PK ledger.pk; pin ANCHOR_MODEL_SHA256 model.sha256; pin ANCHOR_PREFIX_PK prefix.pk
# Catalog pins and catalog assets (payload/anchor_catalog.h, CATALOG.md, opt-in at run time with model_auth=catalog):
# ANCHOR_SOURCE_CATALOG_SHA256 / ANCHOR_ENCODED_CATALOG_SHA256 / ANCHOR_CONVERTER_SHA256 name 64-hex files and land as
# assets/source-catalog.sha256, encoded-catalog.sha256, converter.sha256; ANCHOR_SOURCE_CATALOG / ANCHOR_ENCODED_CATALOG
# name the catalog files and land as assets/model.agcat, model.ewcat. Unset = removed from the stage, like the pins.
# A catalog without its pin, a pin without its catalog, a pin that is not the staged file's digest, or an encoded
# catalog without the source catalog and converter pins refuses to package: the payload would refuse it anyway.
pin ANCHOR_SOURCE_CATALOG_SHA256 source-catalog.sha256; pin ANCHOR_ENCODED_CATALOG_SHA256 encoded-catalog.sha256; pin ANCHOR_CONVERTER_SHA256 converter.sha256
asset() { local var="$1" file="$2"; local src="${!var:-}"; if [ -n "$src" ]; then [ -f "$src" ] || { echo "$var: $src not found" >&2; exit 2; }
          cp "$src" "$STAGE/assets/$file"; echo "staged assets/$file from $src ($(stat -c %s "$src") bytes, sha256 $(sha256sum "$src" | cut -c1-16)...)"; else rm -f "$STAGE/assets/$file"; fi; }
asset ANCHOR_SOURCE_CATALOG model.agcat; asset ANCHOR_ENCODED_CATALOG model.ewcat
asset ANCHOR_MASKBENCH_PADS maskbench.pads   # MASKBENCH: the host-minted PUBLIC shipment the pVM copies and times (payload/anchor_maskbench_mint.c); unset = not packaged
# The production writer creates 0600 files. APK assets are read by the payload UID.
if [ -f "$STAGE/assets/maskbench.pads" ]; then chmod 0644 "$STAGE/assets/maskbench.pads"; fi
for pair in source-catalog.sha256:model.agcat encoded-catalog.sha256:model.ewcat; do p="${pair%%:*}"; a="${pair##*:}"
    if [ -f "$STAGE/assets/$p" ] && [ ! -f "$STAGE/assets/$a" ]; then echo "assets/$p is pinned but assets/$a is not staged" >&2; exit 2; fi
    if [ ! -f "$STAGE/assets/$p" ] && [ -f "$STAGE/assets/$a" ]; then echo "assets/$a is staged but assets/$p is not pinned" >&2; exit 2; fi
    if [ -f "$STAGE/assets/$p" ] && [ "$(sha256sum "$STAGE/assets/$a" | cut -c1-64)" != "$(cat "$STAGE/assets/$p")" ]; then echo "assets/$p is not the digest of the staged assets/$a" >&2; exit 2; fi
done
if [ -f "$STAGE/assets/encoded-catalog.sha256" ] && { [ ! -f "$STAGE/assets/source-catalog.sha256" ] || [ ! -f "$STAGE/assets/converter.sha256" ]; }; then echo "an encoded catalog needs the source-catalog and converter pins" >&2; exit 2; fi
if [ "$MODE" = protected ] && [ "$TIER" = pvm-cpu ]; then [ -f "$STAGE/assets/model.sha256" ] || { echo "protected pvm-cpu build needs assets/model.sha256 (set ANCHOR_MODEL_SHA256)" >&2; exit 2; }
elif [ "$MODE" = protected ]; then for f in ledger.pk model.sha256 prefix.pk; do [ -f "$STAGE/assets/$f" ] || { echo "protected build needs assets/$f (set ANCHOR_LEDGER_PK / ANCHOR_MODEL_SHA256 / ANCHOR_PREFIX_PK)" >&2; exit 2; }; done; fi
echo "payload: $(stat -c %s "$STAGE/lib/arm64-v8a/lib$NAME.so") bytes"
"$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" -d "$STAGE/lib/arm64-v8a/lib$NAME.so" | grep -E 'NEEDED' | sed 's/^/  /'

# --- 3. the host app: one activity, system API via reflection -> classes.dex --
JAVAC="${JAVAC:-javac}"
mkdir -p "$STAGE/classes" "$STAGE/dex"
"$JAVAC" --release 17 -Xlint:-options -cp "$SDK/platforms/android-$API/android.jar" -d "$STAGE/classes" "$HERE"/host/app/*.java
"$BT/d8" --min-api 34 --output "$STAGE/dex" "$STAGE"/classes/host/enclave/anchor/avf/*.class 2>&1 | grep -v '^Warning' || true
[ -f "$STAGE/dex/classes.dex" ] || { echo "d8 produced no classes.dex" >&2; exit 2; }
echo "dex: $(stat -c %s "$STAGE/dex/classes.dex") bytes"

# --- 4. the APK: manifest via aapt2, dex + native lib stored uncompressed ----
cd "$STAGE"
MANIFEST="$HERE/AndroidManifest.xml"
if [ "$TIER" = pvm-cpu ]; then   # no TPU runtime declaration, its own label; same package, so the provisioned model is kept
  MANIFEST="$STAGE/AndroidManifest.xml"
  sed -e '/Shielded-TPU decode: the app-side worker/d' -e '/uses-native-library android:name="libedgetpu_litert.so"/d' \
      -e 's/android:label="Enclave Anchor (AVF)"/android:label="Enclave pVM CPU"/' "$HERE/AndroidManifest.xml" > "$MANIFEST"
  ! grep -q 'libedgetpu\|Anchor (AVF)' "$MANIFEST" || { echo "pvm-cpu: the manifest still names the TPU runtime or the research label" >&2; exit 2; }
fi
"$BT/aapt2" link -o unaligned.apk --manifest "$MANIFEST" \
   -I "$SDK/platforms/android-$API/android.jar" --min-sdk-version 34 --target-sdk-version $API
# extractNativeLibs=false demands STORED (-0) entries, page-aligned by zipalign -p
python3 - "$NAME" <<'PYZ'
import sys, zipfile
name = sys.argv[1]
import glob, os
with zipfile.ZipFile("unaligned.apk", "a", compression=zipfile.ZIP_STORED) as z:
    z.write("dex/classes.dex", "classes.dex", compress_type=zipfile.ZIP_STORED)
    for so in sorted(glob.glob("lib/arm64-v8a/*.so")):
        z.write(so, so, compress_type=zipfile.ZIP_STORED)
    for a in sorted(glob.glob("assets/*")):
        z.write(a, a, compress_type=zipfile.ZIP_STORED)
PYZ
"$BT/zipalign" -p -f 4 unaligned.apk aligned.apk
"$BT/apksigner" sign --ks "$HERE/keys/anchor.jks" --ks-pass pass:anchor123 --ks-key-alias anchor \
   --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled true \
   --out "$OUT/$NAME$SUFFIX.apk" aligned.apk
# the v4 signature's Merkle root IS the pVM's codeHash for this apk (pins.py); vm run-app takes the file as its idsig
"$BT/apksigner" verify --print-certs "$OUT/$NAME$SUFFIX.apk" | grep -E 'SHA-256|Verified' | sed 's/^/  /'
echo "APK: $OUT/$NAME$SUFFIX.apk ($(stat -c %s "$OUT/$NAME$SUFFIX.apk") bytes, tier $TIER)"
