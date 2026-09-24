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
# One read, with BOTH statuses checked: adb's own, and the REMOTE command's, carried back explicitly.
#
# Two versions of this were wrong. The first captured rc after the thermal read only, so a `cat` that
# printed 2000 and exited 42 read as cool. The second checked each read's status but asked the device
# for `dumpsys thermalservice | grep -m1 'Thermal Status'` -- and a pipeline's status is its LAST
# stage's, so grep succeeding hid dumpsys failing. A device whose dumpsys printed "Thermal Status: 0"
# and exited 42 passed the gate.
#
# So nothing is piped on the device any more. The remote command is run alone, its status is carried
# back in an explicit marker, and any filtering happens HERE where the status is already known.
_cg_read() {
  local out rc rrc
  out=$($ADB shell "$1; echo __RC__\$?" 2>/dev/null); rc=$?
  [ "$rc" -eq 0 ] || return 1                       # the transport
  out=$(printf '%s' "$out" | tr -d '\r')
  rrc=$(printf '%s\n' "$out" | sed -n 's/^__RC__\([0-9][0-9]*\)$/\1/p' | tail -1)
  [ -n "$rrc" ] || return 1                         # no marker: the shell never reached the echo
  [ "$rrc" -eq 0 ] || return 1                      # the remote command itself
  printf '%s\n' "$out" | sed '/^__RC__[0-9][0-9]*$/d'
}
# and a frequency must be a POSITIVE integer: 0 = 0 satisfied "uncapped" before this.
_cg_pos() { case "$1" in ''|*[!0-9]*) return 1;; esac; [ "$1" -gt 0 ]; }

cool_gate() {
  local st mx top i why _cg_raw
  if [ "${NOCOOL:-0}" = 1 ]; then
    echo "cool gate: BYPASSED by NOCOOL=1 -- this run is NOT thermally controlled and its rates are not comparable"
    return 0
  fi
  why="no check completed"
  for i in $(seq 1 "${COOL_TRIES:-90}"); do
    if   ! _cg_raw=$(_cg_read "dumpsys thermalservice"); then
      why="the thermal read failed"
      st=""
    elif ! mx=$(_cg_read "cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_max_freq"); then
      why="the scaling_max_freq read failed"
    elif ! top=$(_cg_read "cat /sys/devices/system/cpu/cpu2/cpufreq/cpuinfo_max_freq"); then
      why="the cpuinfo_max_freq read failed"
    elif st=$(printf '%s\n' "$_cg_raw" | grep -m1 'Thermal Status' || true); \
         [ "$st" != "Thermal Status: 0" ]; then
      why="throttled: '${st:-<empty>}'"
    elif ! _cg_pos "$mx"; then
      why="scaling_max_freq is not a positive integer: '${mx:-<empty>}'"
    elif ! _cg_pos "$top"; then
      why="cpuinfo_max_freq is not a positive integer: '${top:-<empty>}'"
    elif [ "$mx" != "$top" ]; then
      why="clocks capped: $mx of $top"
    else
      echo "cool gate: OK Thermal Status: 0 cap=$mx/$top after $i check(s)"
      return 0
    fi
    sleep "${COOL_SLEEP:-10}"
  done
  echo "cool gate: FAILED after ${COOL_TRIES:-90} checks -- $why" >&2
  echo "REFUSING to measure: a rate from a hot or capped phone is not a comparable measurement." >&2
  echo "Set NOCOOL=1 to measure anyway; it will be recorded as uncontrolled and keyed separately." >&2
  return 1
}
