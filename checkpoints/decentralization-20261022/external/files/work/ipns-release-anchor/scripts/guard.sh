#!/bin/bash
# usage: guard.sh CAP_MIB LOG cmd...
# Runs cmd in its own process group; kills the group if its RSS exceeds CAP_MIB, MemAvailable drops below 16 GiB,
# or 900 s pass. Appends one summary line (reason, exit, min MemAvailable, peak group RSS) to LOG.
CAP=$1; LOG=$2; shift 2
setsid "$@" > "$LOG" 2>&1 &
PID=$!
START=$(date +%s); MINAVAIL=999999; MAXRSS=0; REASON=finished; declare -A PEAK
while kill -0 $PID 2>/dev/null; do
  AV=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  RSS=$(ps -o rss= -g $PID 2>/dev/null | awk '{s+=$1}END{print int(s/1024)}')
  [ "$AV" -lt $MINAVAIL ] && MINAVAIL=$AV; [ "${RSS:-0}" -gt $MAXRSS ] && MAXRSS=$RSS
  # per-command peaks (largest single process of each command name)
  while read -r R C; do [ -n "$C" ] && [ "$R" -gt "${PEAK[$C]:-0}" ] && PEAK[$C]=$R; done < <(ps -o rss=,comm= -g $PID 2>/dev/null)
  if [ "${RSS:-0}" -gt "$CAP" ]; then REASON="killed: own RSS ${RSS} MiB > ${CAP}"; kill -KILL -$PID; break; fi
  if [ "$AV" -lt 16384 ]; then REASON="killed: MemAvailable ${AV} MiB < 16384 (own RSS ${RSS} MiB)"; kill -KILL -$PID; break; fi
  if [ $(( $(date +%s) - START )) -gt 900 ]; then REASON="killed: 900 s deadline"; kill -KILL -$PID; break; fi
  sleep 0.5
done
wait $PID 2>/dev/null; CODE=$?
for C in "${!PEAK[@]}"; do echo "guard: peak ${C} $(( ${PEAK[$C]} / 1024 ))MiB"; done | sort >> "$LOG"
echo "guard: $REASON exit=$CODE cap=${CAP}MiB minMemAvailable=${MINAVAIL}MiB maxOwnRSS=${MAXRSS}MiB elapsed=$(( $(date +%s) - START ))s" | tee -a "$LOG"
exit $CODE
