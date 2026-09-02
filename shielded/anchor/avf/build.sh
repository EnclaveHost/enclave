#!/usr/bin/env bash
# build.sh -- one APK carrying a payload for an AVF protected VM.
#
#   ./build.sh attest_probe         # the RKP attestation probe
#   ./build.sh anchor               # the anchor itself (core + simd + field)
#   ./build.sh sink                 # host-side vsock sink for --debug none runs
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
HDR="${AVF_HDR:-/tmp/claude-1000/-home-steven-Projects-enclave/d6ba09ee-f1c1-4290-929f-320d5fb64e3a/scratchpad}"
GG="$HERE/../../../wasm/ggml-shielded"
CORE="$HERE/../core"
OUT="$HERE/out"; STUB="$OUT/stub"; STAGE="$OUT/stage-$NAME"
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
CFLAGS=(-O2 -fPIC -Wall -march=armv8.2-a+dotprod -I"$HDR" -I"$CORE" -I"$GG")
case "$NAME" in
  sink)  # the host side of a --debug none VM's vsock report channel (static, runs from adb shell)
         "$CLANG" -O2 -static -Wall -o "$OUT/vsock-sink" "$HERE/host/vsock-sink.c"
         echo "sink: $OUT/vsock-sink ($(stat -c %s "$OUT/vsock-sink") bytes)"; exit 0 ;;
  attest_probe) SRCS=("$HERE/payload/attest_probe.c") ;;
  anchor)       # the anchor + the harness's worker client over an fd (wire-fd.c wraps the shipped shielded-wire.c)
                SRCS=("$HERE/payload/anchor_payload.c" "$CORE/anchor-core.c" "$GG/shielded-simd.c" "$GG/shielded-field.c"
                      "$HERE/../harness/worker-client.c" "$HERE/../harness/wire-fd.c"
                      "$HERE/payload/third_party/tweetnacl.c")
                CFLAGS+=(-ffp-contract=off -I"$HERE/../harness") ;;
  *) echo "unknown payload $NAME" >&2; exit 2 ;;
esac
"$CLANG" "${CFLAGS[@]}" -shared -o "$STAGE/lib/arm64-v8a/lib$NAME.so" "${SRCS[@]}" \
   -L"$STUB" -lvm_payload -llog -lm -Wl,-soname,lib$NAME.so
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
"$BT/aapt2" link -o unaligned.apk --manifest "$HERE/AndroidManifest.xml" \
   -I "$SDK/platforms/android-$API/android.jar" --min-sdk-version 34 --target-sdk-version $API
# extractNativeLibs=false demands STORED (-0) entries, page-aligned by zipalign -p
python3 - "$NAME" <<'PYZ'
import sys, zipfile
name = sys.argv[1]
with zipfile.ZipFile("unaligned.apk", "a", compression=zipfile.ZIP_STORED) as z:
    z.write("dex/classes.dex", "classes.dex", compress_type=zipfile.ZIP_STORED)
    z.write(f"lib/arm64-v8a/lib{name}.so", f"lib/arm64-v8a/lib{name}.so", compress_type=zipfile.ZIP_STORED)
PYZ
"$BT/zipalign" -p -f 4 unaligned.apk aligned.apk
"$BT/apksigner" sign --ks "$HERE/keys/anchor.jks" --ks-pass pass:anchor123 --ks-key-alias anchor \
   --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled true \
   --out "$OUT/$NAME.apk" aligned.apk
# the v4 signature's Merkle root IS the pVM's codeHash for this apk (pins.py); vm run-app takes the file as its idsig
"$BT/apksigner" verify --print-certs "$OUT/$NAME.apk" | grep -E 'SHA-256|Verified' | sed 's/^/  /'
echo "APK: $OUT/$NAME.apk ($(stat -c %s "$OUT/$NAME.apk") bytes)"
