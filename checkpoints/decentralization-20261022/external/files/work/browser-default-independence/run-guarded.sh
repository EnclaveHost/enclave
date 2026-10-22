#!/bin/bash
# usage: claude-run.sh <cap MiB> <cmd...>
# Scoped coordinator exception (browser-default-independence worker only, 2026-10-20):
#   cap <= 512  -> start when MemAvailable >= 17408 MiB
#   cap  > 512  -> start when MemAvailable >= 18432 MiB (browser 1408)
# Always: MemoryMax=cap, MemorySwapMax=0, memory-guard tree cap, host floor 16384 MiB. Waits at most 55 s per call.
cap=$1; shift
[ "$cap" -le 512 ] && need=17408 || need=18432
for i in $(seq 1 11); do a=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo); [ "$a" -ge $need ] && break; sleep 5; done
echo "[start] cap=${cap}MiB need=${need}MiB available=${a}MiB at $(date -Is)"
[ "$a" -ge $need ] || { echo "[start] not started (below start threshold)"; exit 75; }
exec systemd-run --user --scope --quiet -p MemoryMax=${cap}M -p MemorySwapMax=0 -- node /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/test/helpers/memory-guard.mjs --max-rss-mib $cap --floor-available-mib 16384 -- "$@"
