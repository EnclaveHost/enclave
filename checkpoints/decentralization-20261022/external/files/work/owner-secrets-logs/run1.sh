#!/bin/bash
# run1.sh TEST [CAP_MIB]: wait (<=10 min) for >=18 GiB available, then run TEST under the memory guard, foreground
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclave
t=$1; cap=${2:-512}; n=$(basename $t .test.mjs); L=../owner-secrets-logs
for i in $(seq 1 60); do a=$(awk '/MemAvailable/{print $2}' /proc/meminfo); [ "$a" -ge 18874368 ] && break; sleep 10; done
if [ "$a" -lt 18874368 ]; then echo "$t NOT RUN (avail $a kB)"; exit 3; fi
s=$(date +%s)
CADDY_BIN=${CADDY_BIN:-} timeout 900 node test/helpers/memory-guard.mjs --max-rss-mib $cap --floor-available-mib 16384 -- node --test --test-concurrency=1 $t > $L/compat-$n.log 2>&1; e=$?
echo "$t start_avail=${a}kB exit=$e $(( $(date +%s)-s ))s $(grep -E '^# (pass|fail) ' $L/compat-$n.log | tr '\n' ' ') $(grep -o 'peakTreeRssMiB=[0-9]*' $L/compat-$n.log)"
