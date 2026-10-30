#!/usr/bin/env bash
# app-nn-run.sh <out_dir> <apk> -- milestone 3 on the phone (PVM-CPU.md, "The app runtime"): the model conformance component
# (runtime/conformance/bundles/nn-v1.wasm) delivered to the pvm-cpu payload with --es app_graph, so the VM stages and verifies
# the model, the CPU engine loads and self-tests it, and the component then reaches it only through wasi:nn. Two launches:
#   an-selftest   the engine's self-test through the app path; its digest must equal the engine's own (CAPS) in the same run
#   an-refusals   what the runtime must refuse (a component's own weights, an unknown graph, a second context, bad tensors ...)
# The phone must be awake (the app keeps the screen on while the engine runs). Checked by runtime/conformance/check-app-nn.py.
set -uo pipefail
OUT="$1"; APK="$2"; H="$(cd "$(dirname "$0")/.." && pwd)"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; P=host.enclave.anchor.avf
V="$H/runtime/conformance"; BUNDLE="$V/bundles/nn-v1.wasm"; GRAPH="${GRAPH:-gemma-4-e2b-it-q4_0}"
F=/data/user/0/$P/files
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
want=$(sha256sum "$APK" | cut -c1-64); have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64)
if [ "$want" != "$have" ]; then timeout 300 "$ADB" install -r "$APK" </dev/null >/dev/null 2>&1 || { echo "install failed"; exit 2; }
  have=$(sh_ "sha256sum \$(pm path $P | sed s/package://)" | cut -c1-64); fi
[ "$want" = "$have" ] || { echo "installed APK $have is not $want"; exit 2; }
echo "apk $want installed (hashed on the device)" | tee "$OUT/device.txt"
[ "$(sh_ "run-as $P sh -c 'test -f files/model.gguf && echo Y'")" = Y ] || { echo "no files/model.gguf on the device"; exit 2; }
"$ADB" push "$BUNDLE" /data/local/tmp/app-nn-v1.wasm </dev/null >/dev/null && sh_ "run-as $P cp /data/local/tmp/app-nn-v1.wasm files/app-nn-v1.wasm" >/dev/null
run() {   # run <label> <app_args>
  local l="$1" a="$2"
  [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.log && echo USED'")" = USED ] && { echo "$l: label already used on the device"; return 1; }
  sh_ "am force-stop $P; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard" >/dev/null; sleep 2
  local pw; pw=$(sh_ "dumpsys power")   # captured first: under pipefail, grep -q's early exit fails the pipeline
  grep -q 'mWakefulness=Awake' <<<"$pw" || { echo "$l: PHONE NOT AWAKE: refusing to run"; return 1; }
  sh_ "am start -S -n $P/.Main --es mode app --es vmname anchorlocal --es model $F/model.gguf --es app $F/app-nn-v1.wasm --es app_graph $GRAPH --es app_args '$a' --es capture $l" > "$OUT/$l.am"
  grep -qiE '^Error|Exception|Activity not started|delivered to currently running' "$OUT/$l.am" && { echo "$l: am start did not start the run: $(tr '\n' ' ' < "$OUT/$l.am")"; return 1; }
  local t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt 900 ]; do
    [ "$(sh_ "run-as $P sh -c 'test -e files/capture/$l.complete && echo Y'")" = Y ] && break   # not a grep -q pipe: pipefail
    [ -n "$(sh_ "run-as $P cat files/capture/$l.log" | grep '^CAPTURE END')" ] && break; sleep 5; done
  sh_ "run-as $P cat files/capture/$l.log" > "$OUT/$l.log"; echo "$l: $(grep -c . "$OUT/$l.log") lines in $(( $(date +%s) - t0 )) s"; }
run an-selftest "selftest|$GRAPH"
run an-refusals "refusals|$GRAPH"
GRAPH="$GRAPH" python3 "$V/check-app-nn.py" "$OUT"
