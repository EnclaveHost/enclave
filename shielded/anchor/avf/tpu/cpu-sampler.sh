#!/system/bin/sh
# cpu-sampler.sh <uid> <out> [period_s] [scan_every] -- ON THE PHONE: the CPU of one app uid's processes, stamped with
# /proc/uptime (CLOCK_BOOTTIME, the clock the app stamps its turn window with), plus the device-wide /proc/stat cpu line.
# Runs while <out>.run exists; writes END when told to stop. tpu/cpu-window.py reads it.
#
# Two kinds of sample, because a full process-table scan costs most of a second on a loaded phone and stretched the
# sample intervals past the analyser's 1 s limit at every window edge:
#   FULL  every <scan_every> samples: the whole table (ps), every row of the uid with its /proc/<pid>/stat, "PS ok <rows>"
#         -- or "PS FAILED <rc>" when the enumeration fails; the table is read once and its status kept
#   KNOWN the others: only the pids the last FULL scan found, "PS known <n>"; a pid that has gone reads as GONE
# It records and decides nothing: ownership (parentage), identity (start time) and coverage (scan gaps, failed reads,
# exits, children reaped between scans via cutime/cstime) are the analyser's job, where they are tested.
U="$1"; O="$2"; P="${3:-0.25}"; N="${4:-8}"
: > "$O" || exit 1
KNOWN=""
full() {
  read up idle < /proc/uptime; echo "T $up" >> "$O"; head -1 /proc/stat >> "$O"
  if tbl=$(ps -A -o PID,PPID,UID,NAME) && [ -n "$tbl" ]; then
    KNOWN=""
    echo "$tbl" | while read pid ppid uid name; do
      [ "$uid" = "$U" ] || continue
      s=$(cat /proc/$pid/stat 2>/dev/null) || s=GONE
      echo "P $pid $ppid $name | $s" >> "$O"
    done
    KNOWN=$(echo "$tbl" | while read pid ppid uid name; do [ "$uid" = "$U" ] && echo "$pid:$ppid:$name"; done)
    echo "PS ok $(echo "$tbl" | wc -l)" >> "$O"
  else
    echo "PS FAILED $?" >> "$O"
  fi
}
known() {
  read up idle < /proc/uptime; echo "T $up" >> "$O"; head -1 /proc/stat >> "$O"
  n=0
  for e in $KNOWN; do
    pid=${e%%:*}; r=${e#*:}; ppid=${r%%:*}; name=${r#*:}
    s=$(cat /proc/$pid/stat 2>/dev/null) || s=GONE
    echo "P $pid $ppid $name | $s" >> "$O"; n=$((n + 1))
  done
  echo "PS known $n" >> "$O"
}
i=0
while [ -e "$O.run" ]; do
  if [ $((i % N)) -eq 0 ]; then full; else known; fi
  i=$((i + 1)); sleep "$P"
done
full; echo END >> "$O"
