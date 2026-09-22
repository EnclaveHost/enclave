# coolgate.sh -- sourced by BOTH arm runners. Not a script; it defines cool_gate and nothing else.
#
# It lives in one file because the two arms diverging is the defect it exists to prevent: tpu-run.sh
# had no gate at all while local-run.sh had one, and the TPU arm runs first, so the CPU arm was handed
# a cool uncapped phone every time and the masked arm was handed whatever the previous row left.
#
# And the gate local-run.sh had FAILED OPEN. It looped 90 times, and then -- whatever it had found --
# fell through, printed the bad reading and measured anyway. Driven with a fake device reporting
# Thermal Status 3 and scaling_max 1000 against cpuinfo_max 2000, it completed its 90 checks, printed
# "cool gate: Thermal Status: 3 cap=1000", launched the run and exited 0. A counted loop is not a
# validated gate. Nor were the reads themselves checked: an adb failure, an empty string or a
# non-numeric frequency all compared unequal and simply looped, then fell through the same way.
#
# So: the gate returns non-zero unless the phone is VERIFIABLY cool and uncapped, the caller refuses to
# measure, and the only way past it is NOCOOL=1, which is recorded in the output and folded into the
# cache key so a bypassed run can never be served as a controlled one.
#
#   COOL_TRIES (default 90) and COOL_SLEEP (default 10) exist so the tests can drive it quickly.
cool_gate() {
  local st mx top i rc
  if [ "${NOCOOL:-0}" = 1 ]; then
    echo "cool gate: BYPASSED by NOCOOL=1 -- this run is NOT thermally controlled and its rates are not comparable"
    return 0
  fi
  for i in $(seq 1 "${COOL_TRIES:-90}"); do
    st=$($ADB shell "dumpsys thermalservice 2>/dev/null | grep -m1 'Thermal Status'" 2>/dev/null); rc=$?
    st=$(printf '%s' "$st" | tr -d '\r')
    mx=$($ADB shell cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq 2>/dev/null | tr -d '\r')
    top=$($ADB shell cat /sys/devices/system/cpu/cpu2/cpufreq/cpuinfo_max_freq 2>/dev/null | tr -d '\r')
    # every one of these is a way the old gate silently continued: a failed transport, an empty read,
    # a non-numeric read, a throttled status, or a capped clock
    if [ "$rc" -eq 0 ] && [ "$st" = "Thermal Status: 0" ] \
       && [ -n "$mx" ] && [ -n "$top" ] \
       && [ -z "${mx//[0-9]/}" ] && [ -z "${top//[0-9]/}" ] \
       && [ "$mx" = "$top" ]; then
      echo "cool gate: OK Thermal Status: 0 cap=$mx/$top after $i check(s)"
      return 0
    fi
    sleep "${COOL_SLEEP:-10}"
  done
  echo "cool gate: FAILED after ${COOL_TRIES:-90} checks -- status='${st:-<empty>}' scaling_max='${mx:-<empty>}' cpuinfo_max='${top:-<empty>}'" >&2
  echo "REFUSING to measure: a rate from a hot or capped phone is not a comparable measurement." >&2
  echo "Set NOCOOL=1 to measure anyway; it will be recorded as uncontrolled and keyed separately." >&2
  return 1
}
