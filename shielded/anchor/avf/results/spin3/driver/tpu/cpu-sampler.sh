#!/system/bin/sh
# cpu-sampler.sh <uid> <out> [period_s] -- ON THE PHONE: every period, the process table rows of one app uid and each one's
# /proc/<pid>/stat, stamped with /proc/uptime (CLOCK_BOOTTIME, the clock the app stamps its turn window with), plus the
# device-wide /proc/stat cpu line. Runs while <out>.run exists; writes END when told to stop. tpu/cpu-window.py reads it.
#
# It records everything of the uid and decides nothing: ownership (the app -> its virtmgr -> its crosvm, by parent pid),
# pid reuse (by start time) and coverage (gaps, reads that failed, processes that exited between samples) are the
# analyser's job, where they can be tested.
U="$1"; O="$2"; P="${3:-0.25}"
: > "$O" || exit 1
sample() {
  read up idle < /proc/uptime
  echo "T $up" >> "$O"
  head -1 /proc/stat >> "$O"
  # the table is read ONCE and its status kept: a failed or empty enumeration is written as such, never as "no processes"
  if tbl=$(ps -A -o PID,PPID,UID,NAME) && [ -n "$tbl" ]; then
    n=0
    echo "$tbl" | while read pid ppid uid name; do
      [ "$uid" = "$U" ] || continue
      s=$(cat /proc/$pid/stat 2>/dev/null) || s=GONE
      echo "P $pid $ppid $name | $s" >> "$O"
    done
    echo "PS ok $(echo "$tbl" | wc -l)" >> "$O"
  else
    echo "PS FAILED $?" >> "$O"
  fi
}
while [ -e "$O.run" ]; do sample; sleep "$P"; done
sample; echo END >> "$O"
