#!/usr/bin/env bash
# bench-baseline.sh <out_dir> -- the pVM CPU tier's baseline on the connected phone, BEFORE any optimisation.
#
# Every run goes through the fail-closed driver (tpu/lane-run2.sh via lane-conditions.sh) with GRAPHS=none: the whole model
# in the protected VM on its own vCPUs, no TPU, no pads, and the driver REFUSES a run whose capture shows any TPU record.
# Three batches, with the live thermal trace (cpu/thermal-trace.sh) running across all of them:
#   short/      3 cold single-turn runs, one short prompt, MAXNEW 256: time to first token, short-turn decode rate
#   sustained/  2 cold runs of 4 scripted long turns, MAXNEW 512 each: ~2000 decoded tokens back to back in ONE VM
#   crash/      a run whose VM is killed mid-decode (must be refused, not scored), then a clean relaunch (recovery time)
# The installed APK is used as is and hashed on the device; nothing is installed. The phone must be awake and cool
# (the driver's cool gate). Outputs: each batch's RUNS.tsv + per-run log/cpu/caps/driver, thermal.tsv, device.txt,
# starts.txt (logcat START wall time per run, for launch -> first-token), crash.txt.
set -uo pipefail
OUT="$1"; H="$(cd "$(dirname "$0")/.." && pwd)"
export ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}" GRAPHS=none PKG="${PKG:-host.enclave.anchor.avf}"
mkdir -p "$OUT" || exit 2; [ -e "$OUT/device.txt" ] && { echo "REFUSING: $OUT/device.txt exists"; exit 2; }
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
apk=$(sh_ pm path "$PKG" | sed -n 's/^package://p' | head -1)
{ echo "model: $(sh_ getprop ro.product.model) ($(sh_ getprop ro.product.device)) $(sh_ getprop ro.build.fingerprint)"
  echo "apk: $apk sha256=$(sh_ sha256sum "$apk" | cut -d' ' -f1)"
  echo "uptime_s: $(sh_ cat /proc/uptime | cut -d' ' -f1)  started: $(date -Is)"; } > "$OUT/device.txt"
"$H/cpu/thermal-trace.sh" "$OUT/thermal.tsv" 5 & TT=$!
trap 'touch "$OUT/thermal.tsv.stop"; wait $TT 2>/dev/null' EXIT
start_of() {   # the ActivityManager START of the run's launch, wall clock, from logcat (launch -> first token)
  sh_ logcat -d -b system,main,events -v epoch | grep -E "START u0 .*$PKG/\.Main.*has extras" | tail -1 | awk -v l="$1" '{print l, $1}' >> "$OUT/starts.txt"; }
# a per-run START needs the run to have happened, so short/sustained are run one row at a time
one() {   # one <batch> <label> <maxnew> <ask>
  local d="$OUT/$1"; mkdir -p "$d"; printf '%s\t%s\t\n' "$2" "$1" > "$OUT/$2.tsv"
  MAXNEW=$3 ASK="$4" "$H/tpu/lane-conditions.sh" "$d/$2" "$OUT/$2.tsv"; start_of "$2"; }
SHORT='Write a Python function called reverse_string that returns its argument reversed. Give only the code.'
LONG='Explain in detail how a hash table works, including hashing, collisions, resizing and the cost of each operation.|Now write a complete Python implementation of a hash table with separate chaining, with comments.|Explain the difference between TCP and UDP in detail, with an example of when to use each.|Write a detailed step-by-step guide to creating a Python virtual environment and managing its dependencies.'
for i in 1 2 3; do one short "sh-0$i" 256 "$SHORT"; done
for i in 1 2; do one sustained "su-0$i" 512 "$LONG"; done
"$H/cpu/crash-recovery.sh" "$OUT/crash" "$LONG" > "$OUT/crash.txt" 2>&1
echo "BENCH END $(date -Is)"
