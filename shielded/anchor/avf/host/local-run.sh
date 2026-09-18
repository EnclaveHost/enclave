#!/usr/bin/env bash
# local-run.sh [ask] -- mode local from adb: install nothing, start the diagnostics activity with scripted turns, print the counters.
#   ASK='first|second' ./local-run.sh        VMNAME=anchorlocal MODEL=/data/user/0/host.enclave.anchor.avf/files/model.gguf
# Gated the way every phone CPU measurement must be (LOCAL.md): phone awake + unlocked, thermal status 0, big cores uncapped.
set -uo pipefail
ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"; [ -n "${SERIAL:-}" ] && ADB="$ADB -s $SERIAL"
P=host.enclave.anchor.avf; VMNAME="${VMNAME:-anchorlocal}"; MODEL="${MODEL:-/data/user/0/$P/files/model.gguf}"
ASK="${ASK:-${1:-Say hello in three languages.|Write a 250-word essay about the history of the bicycle.}}"
if [ "${NOCOOL:-0}" != 1 ]; then
  for _ in $(seq 1 90); do st=$($ADB shell "dumpsys thermalservice 2>/dev/null | grep -m1 'Thermal Status'" | tr -d '\r'); mx=$($ADB shell cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq | tr -d '\r'); top=$($ADB shell cat /sys/devices/system/cpu/cpu2/cpufreq/cpuinfo_max_freq | tr -d '\r')
    [ "$st" = "Thermal Status: 0" ] && [ "$mx" = "$top" ] && break; sleep 10; done; echo "cool gate: $st cap=$mx"
fi
$ADB logcat -c
$ADB shell "am force-stop $P; sleep 1; input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard"; sleep 2
[ "$($ADB shell dumpsys power | grep -c 'mWakefulness=Awake')" -ge 1 ] || { echo "PHONE NOT AWAKE: refusing to measure"; exit 1; }
$ADB shell "am start -n $P/.Main --es mode local --es vmname $VMNAME --es model $MODEL ${EXTRA:-} --es ask '$ASK' >/dev/null"
for _ in $(seq 1 360); do sleep 5; $ADB logcat -d -s anchor-host:I | grep -q -E "LOCAL (done|failed)|HOST FAIL|CONTROL closed|VM error|VM stopped" && break; done
$ADB logcat -d -s anchor-host:I | sed 's/.*anchor-host: //' | grep -E "^(HOST FAIL|MODEL (already|streamed)|LOCAL (ready|turn [0-9]+ (STATS|A:)|failed|done)|VSOCK (LOCAL (verified|context|refused)|MODEL (ok|fail)))" | cut -c1-${WIDTH:-260}
echo "awake at end: $($ADB shell dumpsys power | grep -c 'mWakefulness=Awake')  cap: $($ADB shell cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq | tr -d '\r')"
