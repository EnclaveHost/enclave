#!/bin/bash
# The pVM's native libraries, UNSIGNED and without build.sh (which would create or read a keystore): the same compiler, flags,
# sources and link line as shielded/anchor/avf/build.sh step 2 for ANCHOR_TIER=pvm-cpu, then the same llvm-strip.
#   part payload  : libanchor.so for the BASE (pristine) and the CANDIDATE (tree); the base is compared to the INSTALLED one
#   part custody  : libpvmcustody.so (Go c-shared, android/arm64, NDK clang) from the candidate
#   part pvmrt    : libpvm_rt.so (cargo, aarch64-linux-android, release) from the candidate
# usage: build-native.sh payload|custody|pvmrt
set -euo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion
SDK=/home/steven/Android/Sdk; NDK=$SDK/ndk/27.2.12479018; API=35
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin; CLANG=$TC/aarch64-linux-android$API-clang; STRIP=$TC/llvm-strip
O=$H/artifacts/native; mkdir -p $O
INSTALLED=/home/steven/Documents/Codex/2026-10-18/wo/work/phone-dns-recovery/claude/installed-host.apk
part=${1:?part}
case $part in
payload)
  # the payload's SHARED C sources (wasm/ggml-shielded, shielded/anchor/core, shielded/anchor/harness) as the DEPLOYED build
  # had them: the external checkout's commit ea8210a55, exported read-only (git archive). main's newer ggml-shielded is not
  # what the installed payload was built from, and this work changes none of these files.
  DEP=$O/deployed-shared; rm -rf $DEP; mkdir -p $DEP
  git -C /home/steven/Projects/enclave-hosting-ui-android archive ea8210a55544cb0a12fba667635f4801a874cbc8 wasm/ggml-shielded shielded/anchor/core shielded/anchor/harness | tar -x -C $DEP
  for side in base candidate; do
    T=$H/pristine; [ $side = candidate ] && T=$H/tree
    A=$T/shielded/anchor/avf; GG=$DEP/wasm/ggml-shielded; CORE=$DEP/shielded/anchor/core; S=$O/payload-$side; rm -rf $S; mkdir -p $S/stub
    MAP=$A/avfref/libvm_payload.map.txt
    { echo '/* generated: link-time stub for Microdroid libvm_payload.so */';
      grep -oE 'AVm[A-Za-z_]+' "$MAP" | sort -u | while read -r s; do echo "void $s(void) {}"; done; } > $S/stub/stub.c
    $CLANG -shared -fPIC -o $S/stub/libvm_payload.so -Wl,-soname,libvm_payload.so $S/stub/stub.c
    $CLANG -O3 -fPIC -march=armv8.2-a+dotprod -DSH_SIMD_NEON -I"$GG" -c "$GG/shielded-simd.c" -o $S/simd-neon-pic.o
    HARNESS=$DEP/shielded/anchor/harness
    CFLAGS=(-O2 -g -fPIC -Wall -march=armv8.2-a+dotprod -I"$A/avfref" -I"$CORE" -I"$GG" -ffp-contract=off -I"$HARNESS" -DAN_REFILL=sh_simd_neon_refill -DANCHOR_TIER_PVM_CPU)
    SRCS=("$A/payload/anchor_payload.c" "$A/payload/anchor_pins.c" "$A/payload/anchor_names.c" "$A/payload/anchor_gguf.c" "$A/payload/anchor_catalog.c" "$A/payload/anchor_encoded_catalog.c" "$A/payload/anchor_artifacts.c" "$A/payload/anchor_auth.c" "$A/payload/anchor_prepare.c" "$A/payload/anchor_rxctl.c" "$A/payload/anchor_model_cache.c" "$A/payload/anchor_maskbench.c" "$A/payload/anchor_copy.c" "$CORE/anchor-core.c" "$GG/shielded-simd.c" "$GG/shielded-field.c"
          "$HARNESS/worker-client.c" "$HARNESS/wire-fd.c" "$GG/shielded-pads.c" "$GG/shielded-bank.c" "$GG/shielded-http.c" "$GG/prefix-kv.c" "$GG/poly1305-donna.c"
          "$A/payload/third_party/tweetnacl.c" "$S/simd-neon-pic.o")
    ( cd $A && $CLANG "${CFLAGS[@]}" -shared -o $S/libanchor.so "${SRCS[@]}" -L$S/stub -lvm_payload -llog -lm -ldl -Wl,-soname,libanchor.so -Wl,-z,max-page-size=16384 ) > $S/cc.log 2>&1 \
      || { echo "payload $side: compile FAILED"; cat $S/cc.log; exit 1; }
    $STRIP --strip-unneeded $S/libanchor.so
    echo "payload $side: libanchor.so $(sha256sum $S/libanchor.so | cut -c1-64) ($(stat -c %s $S/libanchor.so) B), warnings $(grep -c 'warning:' $S/cc.log || true)"
  done
  python3 - "$INSTALLED" "$O/payload-base/libanchor.so" <<'PY'
import sys, zipfile, hashlib
inst = hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read('lib/arm64-v8a/libanchor.so')).hexdigest()
base = hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest()
print(f"   installed libanchor.so {inst}; base rebuild {'EQUAL (byte-identical rebuild of the deployed payload)' if inst == base else 'DIFFERS (' + base + ')'}")
PY
  ;;
custody)
  cd $H/tree/isolation/m2
  CGO_ENABLED=1 GOOS=android GOARCH=arm64 CC=$CLANG GOFLAGS=-buildvcs=false \
    go build -trimpath -buildmode=c-shared -ldflags "-s -w -extldflags '-Wl,-soname,libpvmcustody.so -Wl,-z,max-page-size=16384'" -o $O/libpvmcustody.so ./cmd/pvmcustody-so/
  rm -f $O/libpvmcustody.h
  $STRIP --strip-unneeded $O/libpvmcustody.so
  $TC/llvm-readelf -d $O/libpvmcustody.so | grep -E 'NEEDED|SONAME' | sed 's/^/   /'
  $TC/llvm-nm -D --defined-only $O/libpvmcustody.so | grep -E ' T pvmc_start$' | sed 's/^/   /'
  echo "custody: libpvmcustody.so $(sha256sum $O/libpvmcustody.so | cut -c1-64) ($(stat -c %s $O/libpvmcustody.so) B)"
  ;;
pvmrt)
  cd $H/tree/shielded/anchor/avf/runtime/pvm-rt
  export CARGO_TARGET_DIR=$H/out/pvm-rt-target CARGO_BUILD_JOBS=1
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$CLANG CC_aarch64_linux_android=$CLANG AR_aarch64_linux_android=$TC/llvm-ar
  cargo build --locked --offline --release --target aarch64-linux-android
  cp $CARGO_TARGET_DIR/aarch64-linux-android/release/libpvm_rt.so $O/libpvm_rt.so
  $STRIP --strip-unneeded $O/libpvm_rt.so
  echo "pvmrt: libpvm_rt.so $(sha256sum $O/libpvm_rt.so | cut -c1-64) ($(stat -c %s $O/libpvm_rt.so) B)"
  ;;
*) echo "unknown part $part" >&2; exit 2 ;;
esac
