#!/usr/bin/env bash
# tpu-run.sh -- Shielded-TPU decode from adb (TPU.md): scripted turns through mode local with the TPU worker; prints counters.
#   ASK='a|b' BANK=64 MAXNEW=48 ./tpu-run.sh      files are expected in the app's files dir: model.gguf, tpu/g5/L*.tflite, tpu/lanes.etpu
set -uo pipefail
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; [ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"
P=host.enclave.anchor.avf; F=/data/user/0/$P/files; ASK="${ASK:-What is the capital of France? One sentence.|Do you know who Bill Gates is? Answer in two sentences.}"
$ADB logcat -c; $ADB shell "am force-stop $P; sleep 1; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"; sleep 2
[ "$($ADB shell dumpsys power | grep -c 'mWakefulness=Awake')" -ge 1 ] || { echo "PHONE NOT AWAKE: refusing to measure"; exit 1; }
$ADB shell "am start -n $P/.Main --es mode local --es vmname ${VMNAME:-anchorlocal} --ei mem ${MEM:-8192} --es model $F/model.gguf --es tpu_graphs $F/${GRAPHS:-tpu/g5} --es tpu_bundle $F/${BUNDLE:-tpu/lanes.etpu} --ei tpu_bank ${BANK:-64} --ei max_new ${MAXNEW:-48} ${EXTRA:-} --es ask '$ASK' >/dev/null"
for _ in $(seq 1 240); do sleep 5; $ADB logcat -d -s anchor-host:I | grep -q -E "LOCAL (done|failed)|HOST FAIL|CONTROL closed|VM error|VM stopped" && break; done
$ADB logcat -d -s anchor-host:I | sed 's/.*anchor-host: //' | grep -E "HOST FAIL|VM (error|stopped)|^TPU|LOCAL (turn [0-9]+ (A:|STATS)|done|failed)|VSOCK (LOCAL )?(tpu|refused)" | cut -c1-${WIDTH:-600}
