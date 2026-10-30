#!/system/bin/sh
# cpu-sampler.sh <uid> <out> [period_s] [scan_s] -- ON THE PHONE: the CPU of one app uid's processes, stamped with
# /proc/uptime (CLOCK_BOOTTIME, the clock the app stamps its turn window with), plus the device-wide /proc/stat cpu line.
# Runs while <out>.run exists; writes END when told to stop. tpu/cpu-window.py reads it.
#
# Two loops, because a process-table scan takes up to ~1.3 s on a loaded phone and, done inline, stretched the timing
# samples past the analyser's 1 s limit at the window edges:
#   DISCOVERY (background, every scan_s): the whole table once (ps), its status kept; the uid's pids go to <out>.pids and
#             the scan is recorded as ONE line in <out>.d:  D <start> <end> ok <rows>   or   D <start> <end> FAILED <rc>
#   TIMING    (foreground, every period_s): T <uptime>, the /proc/stat line, "P <pid> <ppid> <name> | <stat>" for every pid
#             of the last discovery (GONE when it has exited), then "PS known <n>"
# At stop the discovery lines are appended to <out>. It records and decides nothing: ownership (parentage), identity
# (start time) and coverage (sample and scan gaps, failed reads and scans, exits, children reaped between scans) are the
# analyser's job, where they are tested.
U="$1"; O="$2"; P="${3:-0.25}"; S="${4:-2}"
: > "$O" || exit 1; : > "$O.d"; : > "$O.pids"
discover() {   # $1: a tag unique to the caller, so two discoveries never share a temp file
  read t0 idle < /proc/uptime
  if tbl=$(ps -A -o PID,PPID,UID,NAME) && [ -n "$tbl" ]; then
    echo "$tbl" | while read pid ppid uid name; do [ "$uid" = "$U" ] && echo "$pid $ppid $name"; done > "$O.pids.$1"
    if mv "$O.pids.$1" "$O.pids"; then
      read t1 idle < /proc/uptime; echo "D $t0 $t1 ok $(echo "$tbl" | wc -l)" >> "$O.d"
    else
      read t1 idle < /proc/uptime; echo "D $t0 $t1 FAILED mv" >> "$O.d"
    fi
  else
    rc=$?; read t1 idle < /proc/uptime; echo "D $t0 $t1 FAILED $rc" >> "$O.d"
  fi
}
( while [ -e "$O.run" ]; do discover bg; sleep "$S"; done; discover bg ) &
DPID=$!
discover fg   # the first timing sample must already know the pids
timing() {
  read up idle < /proc/uptime; echo "T $up" >> "$O"; head -1 /proc/stat >> "$O"
  n=0
  while read pid ppid name; do
    s=$(cat /proc/$pid/stat 2>/dev/null) || s=GONE
    echo "P $pid $ppid $name | $s" >> "$O"; n=$((n + 1))
  done < "$O.pids"
  echo "PS known $n" >> "$O"
}
while [ -e "$O.run" ]; do timing; sleep "$P"; done
timing   # one more AFTER the stop: the driver stops us just after the window ends, so this sample is what brackets its end
wait $DPID
cat "$O.d" >> "$O"; rm -f "$O.d" "$O.pids" "$O.pids.fg" "$O.pids.bg"; echo END >> "$O"
