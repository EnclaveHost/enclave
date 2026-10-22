#!/bin/bash
# usage: gate.sh <max-wait-seconds> <logname> <command...>
# Foreground: polls until MemAvailable >= 17920 MiB (coordinator-approved start for this stream), then runs ONE job in
# run-bounded768.sh (MemoryMax 768M, no swap, 16 GiB floor watchdog). Exit 75 if capacity never came.
max=$1; shift
for ((i=0; i<max; i+=5)); do
  a=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
  if [ "$a" -ge 18350080 ]; then
    echo "gate: start at MemAvailable_kB=$a after ${i}s"
    exec /home/steven/Documents/Codex/2026-10-18/wo/work/storage-real-indexd/logs/run-bounded768.sh "$@"
  fi
  sleep 5
done
echo "gate: MemAvailable_kB=$a still below 17920 MiB after ${max}s; not started"; exit 75
