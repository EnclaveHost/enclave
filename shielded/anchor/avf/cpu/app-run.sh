#!/usr/bin/env bash
# app-run.sh <out_dir> <apk> -- milestone 2 on the phone (PVM-CPU.md, "The app runtime"): the portable conformance component
# delivered from OUTSIDE the APK to the pvm-cpu payload (APP line + APP_PORT), verified, compiled to Pulley inside the pVM
# and run. One launch per vectors.json case, plus one whose announced digest is not the component's (the app's app_sha256
# test hook): the VM must refuse it before compiling. The captures are checked by runtime/conformance/check-app.py.
set -uo pipefail
OUT="$1"; APK="$2"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/hello-v1.wasm"
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { echo "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { echo "installed APK $have is not $want"; exit 2; }
echo "apk $want installed (hashed on the device)" | tee "$OUT/device.txt"
"$ADB" push "$BUNDLE" /data/local/tmp/app-hello-v1.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-hello-v1.wasm files/app-hello-v1.wasm" >/dev/null
F=/data/user/0/$P/files/app-hello-v1.wasm
RUN_ID="${RUN_ID:-$(date +%m%d%H%M%S)}"   # device capture labels are unique per run: a reused label makes the app refuse to capture
run() {   # run <label> [extra am args...]; the capture is saved as $OUT/<label>.log
  local l="$1" d="$RUN_ID-$1"; shift
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$d.log && echo USED'")" = USED ] && { echo "$d: label already used on the device"; return 1; }
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP" >/dev/null
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es app $F --es capture $d $*" > "$OUT/$l.am"
  for _ in $(seq 1 60); do [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$d.complete && echo Y'")" = Y ] && break
    [ -n "$(sh_ "run-as $P cat files/capture/$d.log" | grep '^CAPTURE END')" ] && break; sleep 3; done
  sh_ "run-as $P cat files/capture/$d.log" > "$OUT/$l.log"; echo "$l ($d): $(grep -c . "$OUT/$l.log") lines"; }
run ap-case0
run ap-case1 "--es app_args 'a|b'"
run ap-case2 "--es app_args 'exit|7'"
run ap-baddigest "--es app_sha256 $(printf '%064d' 0)"
python3 "$V/check-app.py" "$OUT"
