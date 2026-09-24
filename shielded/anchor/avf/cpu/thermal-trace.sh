#!/usr/bin/env bash
# thermal-trace.sh <out.tsv> [interval_s] -- the phone's LIVE thermal and memory state, one TSV row per interval, until
# killed (or until the file $out.stop appears). For the pVM CPU benchmarks: sustained decode is thermally bound on a phone,
# so every throughput figure is read next to this trace.
#
# Only "Current temperatures from HAL" is read. `dumpsys thermalservice` ALSO prints "Cached temperatures", which keep the
# last value each sensor reported to a listener and can be minutes old (a cached BIG 87 C was once quoted as live).
# Columns: t_s status BIG BIG_MID MID LITTLE skin soc  cap_cpu2_khz cap_cpu7_khz  cd_big cd_cpu2 cd_cpu0  mem_avail_kb
#   status  Android thermal status (0 none .. 6 shutdown), live
#   cap_*   cpufreq scaling_max_freq, what the governor may run the core at now (3052000 / 3782000 unthrottled)
#   cd_*    the thermal HAL's cooling-device values for the big clusters and cpu0 (their frequency ceiling, kHz)
set -u
OUT="$1"; IV="${2:-5}"; ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}"
printf 't_s\tstatus\tBIG\tBIG_MID\tMID\tLITTLE\tskin\tsoc\tcap_cpu2\tcap_cpu7\tcd_big\tcd_cpu2\tcd_cpu0\tmem_avail_kb\n' > "$OUT"
t0=$(date +%s)
while [ ! -e "$OUT.stop" ]; do
  d=$("$ADB" shell 'dumpsys thermalservice; echo "CAPS $(cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq) $(cat /sys/devices/system/cpu/cpu7/cpufreq/scaling_max_freq)"; grep MemAvailable /proc/meminfo' </dev/null 2>/dev/null | tr -d '\r')
  [ -n "$d" ] && awk -v t=$(( $(date +%s) - t0 )) '
    /^Thermal Status:/ { st=$3 }
    /^Current temperatures from HAL:/ { live=1; next }
    /^Current cooling devices from HAL:/ { live=0; cool=1; next }
    /^Temperature static thresholds/ { cool=0 }
    live && /Temperature\{/ { match($0,/mValue=[-0-9.E]+/); v=substr($0,RSTART+7,RLENGTH-7); match($0,/mName=[^,}]+/); n=substr($0,RSTART+6,RLENGTH-6); T[n]=v }
    cool && /CoolingDevice\{/ { match($0,/mValue=[0-9]+/); v=substr($0,RSTART+7,RLENGTH-7); match($0,/mName=[^,}]+/); n=substr($0,RSTART+6,RLENGTH-6); C[n]=v }
    /^CAPS / { c2=$2; c7=$3 }
    /^MemAvailable:/ { m=$2 }
    END { printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", t, st, T["BIG"], T["BIG_MID"], T["MID"], T["LITTLE"], T["VIRTUAL-SKIN"], T["soc_therm"], c2, c7, C["big_and_big_mid"], C["cpufreq-cpu2"], C["cpufreq-cpu0"], m }' <<<"$d" >> "$OUT"
  sleep "$IV"
done
