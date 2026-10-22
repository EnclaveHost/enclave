#!/bin/bash
# usage: run-guard.sh LOG (CAP env, default 512) cmd... ; kills its own process group if own RSS > 768 MiB, MemAvailable < 16 GiB or after 900 s
LOG=$1; shift
AV0=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ $AV0 -lt ${START_FLOOR:-18432} ]; then echo "guard: NOT STARTED: MemAvailable ${AV0} MiB < ${START_FLOOR:-18432}" | tee "$LOG"; exit 75; fi
setsid "$@" > "$LOG" 2>&1 &
PID=$!
START=$(date +%s); MINAVAIL=999999; MAXRSS=0; REASON=finished
while kill -0 $PID 2>/dev/null; do
  AV=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  RSS=$(ps -o rss= -g $PID 2>/dev/null | awk '{s+=$1}END{print int(s/1024)}')
  [ $AV -lt $MINAVAIL ] && MINAVAIL=$AV; [ "${RSS:-0}" -gt $MAXRSS ] && MAXRSS=$RSS
  echo "$(( $(date +%s) - START ))s avail=${AV} ownRSS=${RSS}" >> "$LOG.mem"
  if [ "${RSS:-0}" -gt ${CAP:-512} ]; then REASON="killed: own RSS ${RSS} MiB > ${CAP:-512}"; kill -KILL -$PID; break; fi
  if [ $AV -lt 16384 ]; then REASON="killed: MemAvailable ${AV} MiB < 16384 (own RSS ${RSS} MiB)"; kill -KILL -$PID; break; fi
  if [ $(( $(date +%s) - START )) -gt 900 ]; then REASON="killed: 900 s deadline"; kill -KILL -$PID; break; fi
  sleep 1
done
wait $PID 2>/dev/null; CODE=$?
echo "guard: $REASON exit=$CODE minMemAvailable=${MINAVAIL}MiB maxOwnRSS=${MAXRSS}MiB elapsed=$(( $(date +%s) - START ))s" | tee -a "$LOG"
