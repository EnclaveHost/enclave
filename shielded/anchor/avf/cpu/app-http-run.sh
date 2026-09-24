#!/usr/bin/env bash
# app-http-run.sh <out_dir> <apk> -- milestone 4 on the phone (PVM-CPU.md, "The app runtime"): enclave-apps' ggml-probe, a
# first-party wasi:http app, bytes unchanged (runtime/conformance/bundles/ggml-probe.wasm), served inside the pVM over the
# verified model (--es app_graph) and asked through the app's test hook (--es app_http): /ping, the same generation twice
# (a fresh instance each time: identical answers), an unknown route and a graph the VM does not serve. One launch, one
# model load. Checked by runtime/conformance/check-app-http.py.
set -uo pipefail
OUT="$1"; APK="$2"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/ggml-probe.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"; STEPS="${STEPS:-16}"
F=/data/user/0/$P/files
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { echo "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { echo "installed APK $have is not $want"; exit 2; }
echo "apk $want installed (hashed on the device)" | tee "$OUT/device.txt"
"$ADB" push "$BUNDLE" /data/local/tmp/app-ggml-probe.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-ggml-probe.wasm files/app-ggml-probe.wasm" >/dev/null
l=ah-probe
[ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.log && echo USED'")" = USED ] && { echo "$l: label already used on the device"; exit 1; }
sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
pw=$(sh_ "dumpsys power")   # captured first: under pipefail, grep -q's early exit fails the pipeline
grep -q 'mWakefulness=Awake' <<<"$pw" || { echo "PHONE NOT AWAKE: refusing to run"; exit 1; }
Q="/?graph=$GRAPH&steps=$STEPS"
sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-ggml-probe.wasm --es app_graph $GRAPH --es app_http '/ping|$Q|$Q|/nope|/?graph=other-model&steps=2' --es capture $l" > "$OUT/$l.am"
grep -qiE '^Error|Exception|Activity not started|delivered to currently running' "$OUT/$l.am" && { echo "am start did not start the run: $(tr '\n' ' ' < "$OUT/$l.am")"; exit 1; }
t0=$(date +%s)
while [ $(( $(date +%s) - t0 )) -lt 900 ]; do   # no grep -q pipes here: under pipefail its early exit reads as a failure
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.complete && echo Y'")" = Y ] && break
  [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && break; sleep 5; done
sh_ "run-as $P cat files/capture/$l.log" > "$OUT/$l.log"; echo "$l: $(grep -c . "$OUT/$l.log") lines in $(( $(date +%s) - t0 )) s"
GRAPH="$GRAPH" STEPS="$STEPS" python3 "$V/check-app-http.py" "$OUT"
