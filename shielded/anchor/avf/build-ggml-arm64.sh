#!/usr/bin/env bash
# build-ggml-arm64.sh -- the pinned llama.cpp for the phone: arm64-v8a, CPU only,
# loadable backends, NO weight repacking.
#
#   ./build-ggml-arm64.sh [work-dir]      # default: out/ggml-arm64-work
#
# Produces <work>/prefix/lib/{libllama,libggml,libggml-base,libggml-cpu}.so and
# the headers. Same pin and the same non-CUDA flags as
# .github/workflows/llamacpp-toolchain.yml (GGML_MAX_NAME=128, GGML_BACKEND_DL,
# GGML_NATIVE=OFF), plus two that matter on ARM:
#   GGML_CPU_ARM_ARCH  dotprod+i8mm, what Tensor G3+ has and what the SDOT
#                      refill wants.
#   GGML_CPU_REPACK=OFF  the ARM CPU backend otherwise REPACKS q8_0 rows into
#                      q8_0_4x8 at load (a CPU_REPACK buffer), and the shielded
#                      encoder, which reads the tensor's bytes as plain q8_0 rows,
#                      then finds no exponent that fits and offloads NOTHING
#                      (found the hard way 2026-09-02). The GEMMs go to the
#                      worker anyway, so the repacked CPU kernels buy nothing here.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$HERE/out/ggml-arm64-work}"
PIN="$(grep -oE 'LLAMA_COMMIT: [0-9a-f]+' "$HERE/../../../.github/workflows/llamacpp-toolchain.yml" | awk '{print $2}')"
NDK="${ANDROID_NDK:-$HOME/Android/Sdk/ndk/27.2.12479018}"
[ -n "$PIN" ] || { echo "no LLAMA_COMMIT pin found in the toolchain workflow" >&2; exit 2; }
mkdir -p "$WORK"; cd "$WORK"
if [ ! -d llama.cpp/.git ]; then
  if [ -d "$HOME/Projects/llama.cpp/.git" ]; then git clone -q "$HOME/Projects/llama.cpp" llama.cpp; else git clone -q https://github.com/ggml-org/llama.cpp llama.cpp; fi
fi
cd llama.cpp; git fetch -q https://github.com/ggml-org/llama.cpp "$PIN"; git checkout -q "$PIN"; echo "llama.cpp at $(git rev-parse --short HEAD) (pin $PIN)"
cmake -B build-android -G Ninja -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-34 \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_CUDA=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_LLAMAFILE=OFF \
  -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+i8mm -DGGML_CPU_REPACK=OFF \
  -DCMAKE_C_FLAGS="-DGGML_MAX_NAME=128" -DCMAKE_CXX_FLAGS="-DGGML_MAX_NAME=128" \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_BUILD_COMMON=OFF -DLLAMA_CURL=OFF \
  -DCMAKE_INSTALL_PREFIX="$WORK/prefix" > "$WORK/configure.log" 2>&1
cmake --build build-android -j"$(nproc)" --target llama ggml-cpu ggml-base ggml > "$WORK/build.log" 2>&1
cmake --install build-android > "$WORK/install.log" 2>&1
cp build-android/bin/libggml-cpu.so build-android/bin/libllama.so "$WORK/prefix/lib/"     # the module and libllama are not installed by cmake --install
cp "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$WORK/prefix/lib/"
echo "prefix: $WORK/prefix"; ls "$WORK/prefix/lib"
