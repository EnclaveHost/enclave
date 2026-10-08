#!/usr/bin/env bash
# app-cpu-run.sh <out_dir> <apk> -- the pVM CPU tier on the phone (PVM-CPU.md, "The app runtime"): a CPU-only wasi:http app
# (runtime/conformance/bundles/cpu-probe.wasm: no wasi:nn, no model) served inside the protected VM and asked through the
# app's test hook (--es app_http): /ping, the same computation twice (a fresh instance each time: identical values, and
# the exact values the checker predicts), an unknown route, and a heavier run. No model is staged or named. Checked by
# runtime/conformance/check-app-cpu.py.
set -uo pipefail
OUT="$1"; APK="$2"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/cpu-probe.wasm"; LABEL="${LABEL:-ac-probe}"; VM="${VMNAME:-anchorcpu}"   # AM_EXTRA: more am extras (e.g. "--ei mem 2048")
F=/data/user/0/$P/files
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { echo "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { echo "installed APK $have is not $want"; exit 2; }
echo "apk $want installed (hashed on the device)" | tee "$OUT/device.txt"
"$ADB" push "$BUNDLE" /data/local/tmp/app-cpu-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-cpu-probe.wasm files/app-cpu-probe.wasm" >/dev/null
[ "$(sh_ "run-as $P sh -c 'test -e files/capture/$LABEL.log && echo USED'")" = USED ] && { echo "$LABEL: label already used on the device"; exit 1; }
sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
pw=$(sh_ "dumpsys power")   # captured first: under pipefail, grep -q's early exit fails the pipeline
grep -q 'mWakefulness=Awake' <<<"$pw" || { echo "PHONE NOT AWAKE: refusing to run"; exit 1; }
Q="/?steps=8&work=1000"
sh_ "am start -S -n $P/.Main --es mode app --es vmname $VM --es app $F/app-cpu-probe.wasm --es app_http '/ping|$Q|$Q|/nope|/?steps=4&work=200000' --es capture $LABEL ${AM_EXTRA:-}" > "$OUT/$LABEL.am"
grep -qiE '^Error|Exception|Activity not started|delivered to currently running' "$OUT/$LABEL.am" && { echo "am start did not start the run: $(tr '\n' ' ' < "$OUT/$LABEL.am")"; exit 1; }
t0=$(date +%s)
while [ $(( $(date +%s) - t0 )) -lt 600 ]; do   # no grep -q pipes here: under pipefail its early exit reads as a failure
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$LABEL.complete && echo Y'")" = Y ] && break
  [ -n "$(sh_ "run-as $P cat files/capture/$LABEL.log" | grep '^CAPTURE END')" ] && break; sleep 5; done
sh_ "run-as $P cat files/capture/$LABEL.log" > "$OUT/$LABEL.log"; echo "$LABEL: $(grep -c . "$OUT/$LABEL.log") lines in $(( $(date +%s) - t0 )) s"
LABEL="$LABEL" python3 "$V/check-app-cpu.py" "$OUT"
