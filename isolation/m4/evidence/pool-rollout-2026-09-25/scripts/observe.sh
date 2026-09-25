#!/usr/bin/env bash
# The 10-minute functional gate, clock-read. Every ~2 min: all 3 canaries answer 200 over valid public TLS with their S0
# keys (lib.sh public_ok: exactly 3 checked, one retry each), and the relay lists metal-iso0 serving and eligible.
# v2 (enclave-99 M6): refuses to run without a readable 3-canary keys file. Exits 1 at the first failed round.
set -uo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh
L=${1:?label}; K=$EV/canary-keys.txt; LOG=$EV/$L-observe.log
[ -r "$K" ] && [ "$(grep -cE '^[0-9a-f]{8} [0-9a-f]{64}$' "$K")" = 3 ] && [ "$(wc -l < "$K")" = 3 ] || { echo "REFUSING: $K is not exactly 3 canary keys"; exit 2; }
start=$(date +%s); end=$((start + 600)); round=0; echo "observe $L from $(date -u +%H:%M:%SZ) for 600 s" | tee $LOG
while :; do
  round=$((round+1))
  if public_ok && relay_row_ok; then echo "r$round $(date -u +%H:%M:%SZ) 3/3 canaries 200+key, relay serving" | tee -a $LOG
  else echo "r$round $(date -u +%H:%M:%SZ) FAILED" | tee -a $LOG; echo "GATE FAILED in round $round" | tee -a $LOG; exit 1; fi
  now=$(date +%s); [ $now -ge $end ] && break
  while [ $(date +%s) -lt $((now + 120)) ] && [ $(date +%s) -lt $end ]; do sleep 5; done
done
echo "GATE PASSED: $round rounds over $(( $(date +%s) - start )) s (read from the clock)" | tee -a $LOG
