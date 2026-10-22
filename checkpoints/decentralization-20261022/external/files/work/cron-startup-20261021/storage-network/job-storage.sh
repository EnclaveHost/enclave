#!/bin/bash
S=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/storage-network
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 150 python3 $S/host-state.py > /dev/null; echo host rc=$?
cd $S
timeout 120 node chain-read-any.mjs 0xef514ed3af4e891d9718fe26552bf2637a59ec80c7fbac2bb292e8891212b238 > chain-storage.json; echo chainS rc=$?
timeout 120 node chain-read-any.mjs 0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c > chain-cron.json; echo chainC rc=$?
for p in /healthz /; do curl -sS --max-time 30 --resolve ef514ed3.app.enclave.host:443:134.199.235.187 https://ef514ed3.app.enclave.host$p -w "\n%{http_code} %{time_total}\n" | head -c 600 > storage-body$(echo $p | tr / _).txt; echo "body $p rc=$?"; done
