#!/usr/bin/env bash
# lane-run.sh <label> -- one gated Shielded-TPU decode whose output survives a flooded logcat.
#
# tpu-run.sh reads its results back out of logcat, whose main ring on this phone is 256 KiB. On a warm,
# charging phone pixel-thermal logs several lines a second and rotated a whole run's result lines out
# before the script read them (2026-09-22: every anchor-host line gone, the run unrecoverable). This asks
# the app for its own capture file (--es capture, CaptureSink.java: exclusive, footer + .complete marker)
# and pulls that instead. It also samples the big cores' frequency cap through the run, because the cool
# gate only checks the START and the same afternoon showed the cap falling to 1.2 GHz mid-run.
#
#   GRAPHS=tpu/g5-h4ds BUNDLE=tpu/lanes-h4ds.etpu MAXNEW=256 ASK='...' EXTRA='--ei tpu_spin 3000' OUT=dir ./lane-run.sh w4-0
set -uo pipefail
LABEL="$1"; [[ "$LABEL" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "bad label"; exit 2; }
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; OUT="${OUT:-.}"; mkdir -p "$OUT"
P=host.enclave.anchor.avf; F=/data/user/0/$P/files; ASK="${ASK:?ASK is required}"
. "$(cd "$(dirname "$0")/../host" && pwd)/coolgate.sh"
cool_gate || exit 4
$ADB shell "run-as $P sh -c 'test -e files/capture/$LABEL.log'" && { echo "label $LABEL already used on the device"; exit 2; }
$ADB shell "am force-stop $P; sleep 1; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"; sleep 2
[ "$($ADB shell dumpsys power | grep -c 'mWakefulness=Awake')" -ge 1 ] || { echo "PHONE NOT AWAKE: refusing to measure"; exit 1; }
$ADB shell "am start -n $P/.Main --es mode local --es vmname ${VMNAME:-anchorlocal} --ei mem ${MEM:-8192} --es model $F/model.gguf --es tpu_graphs $F/${GRAPHS:-tpu/g5} --es tpu_bundle $F/${BUNDLE:-tpu/lanes.etpu} --ei tpu_bank ${BANK:-64} --ei max_new ${MAXNEW:-48} --es capture $LABEL ${EXTRA:-} --es ask '$ASK' >/dev/null"
t0=$(date +%s); : > "$OUT/$LABEL.caps"
for _ in $(seq 1 720); do
  sleep 5
  echo "$(( $(date +%s) - t0 )) $($ADB shell 'cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq /sys/devices/system/cpu/cpu7/cpufreq/scaling_max_freq' | tr -d '\r' | tr '\n' ' ')" >> "$OUT/$LABEL.caps"
  $ADB shell "run-as $P sh -c 'test -e files/capture/$LABEL.complete'" && break
done
$ADB shell "run-as $P cat files/capture/$LABEL.log" > "$OUT/$LABEL.log"
$ADB shell "run-as $P sh -c 'test -e files/capture/$LABEL.complete'" && echo "capture complete" || echo "CAPTURE INCOMPLETE (timed out or the app died)"
grep -E "HOST FAIL|VM (error|stopped)|LOCAL (turn [0-9]+ STATS|failed)|tpu turn|TPU worker: [0-9]+ exchanges|CAPTURE (END|INVALID)" "$OUT/$LABEL.log" | cut -c1-${WIDTH:-400}
awk '{ if (min2 == "" || $2 < min2) min2 = $2; if (min7 == "" || $3 < min7) min7 = $3 } END { print "big-core cap through the run: cpu2 min " min2 ", cpu7 min " min7 " (" NR " samples)" }' "$OUT/$LABEL.caps"
