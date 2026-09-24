#!/usr/bin/env bash
# crash-recovery.sh <out_dir> <ask> -- the pVM dies mid-decode: the run must be REFUSED by the fail-closed driver (never
# scored), then a relaunch must reach READY and decode again. Records the kill time (device wall clock), the driver's verdict
# on the killed run, and the relaunch's launch -> READY -> first-token times, so "recovery" is a measured interval.
# The VM is killed as the app would lose it: SIGKILL to its crosvm process (run as the app's uid), the app left running.
set -uo pipefail
OUT="$1"; ASK="$2"; H="$(cd "$(dirname "$0")/.." && pwd)"
export ADB="${ADB:-$HOME/Android/Sdk/platform-tools/adb}" GRAPHS=none PKG="${PKG:-host.enclave.anchor.avf}" MAXNEW=512
sh_() { "$ADB" shell "$@" </dev/null 2>/dev/null | tr -d '\r'; }
mkdir -p "$OUT" || exit 2
printf 'cr-01\tkilled\t\n' > "$OUT/cr-01.tsv"; printf 'cr-02\trelaunch\t\n' > "$OUT/cr-02.tsv"
ASK="$ASK" "$H/tpu/lane-conditions.sh" "$OUT/cr-01" "$OUT/cr-01.tsv" > "$OUT/cr-01.out" 2>&1 & R=$!
# wait (<= 6 min) for the first decode turn to start in the VM, then let it decode ~15 s
for _ in $(seq 1 72); do
  sh_ run-as "$PKG" sh -c "grep -q 'LOCAL ready' files/capture/cr-01.log 2>/dev/null && echo Y" | grep -q Y && break; sleep 5; done
sleep 15
pid=$(sh_ ps -A -o PID,NAME | awk '$2=="crosvm_anchorlocal"{print $1}' | head -1)
[ -n "$pid" ] || { echo "no crosvm_anchorlocal to kill (the VM was not up)"; wait $R; exit 1; }
kill_wall=$(date +%s.%N); sh_ run-as "$PKG" kill -9 "$pid"; echo "killed crosvm_anchorlocal pid=$pid at wall $kill_wall"
wait $R; echo "killed run's driver: $(grep -v '^#' "$OUT/cr-01/RUNS.tsv" | cut -f1,4,5 | tr '\t' ' ')"
grep -h "LANE-RUN" "$OUT/cr-01/cr-01.driver" "$OUT/cr-01.out" 2>/dev/null | tail -1
alive=$(sh_ ps -A -o NAME | grep -c '^crosvm_anchorlocal$'); echo "crosvm_anchorlocal processes after the kill: $alive"
# relaunch at once: a normal run through the same driver
rl_wall=$(date +%s.%N)
ASK="$ASK" "$H/tpu/lane-conditions.sh" "$OUT/cr-02" "$OUT/cr-02.tsv" > "$OUT/cr-02.out" 2>&1
echo "relaunch driver: $(grep -v '^#' "$OUT/cr-02/RUNS.tsv" | cut -f1,4,5 | tr '\t' ' ')  (relaunch requested at wall $rl_wall)"
grep -h "load_s=\|turn 1 window" "$OUT/cr-02/cr-02.log" 2>/dev/null | head -2
echo "START of the relaunch: $(sh_ logcat -d -b system,main,events -v epoch | grep -E "START u0 .*$PKG/\.Main.*has extras" | tail -1 | awk '{print $1}')"
echo "device boottime->wall offset now: $(sh_ 'echo $(cut -d" " -f1 /proc/uptime) $(date +%s.%N)')"
