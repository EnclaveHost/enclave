#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
date -u +%H:%M:%SZ
curl -sS --max-time 40 -o /dev/null -w 'public / -> %{http_code} in %{time_total}s\n' https://38f368d6.app.enclave.host/ ; echo rc=$?
timeout 300 python3 probe.py grep node.log --tail 6000 --max 12 --pat '38f368d6' --not 'applied to' > logs-final.json; echo rc=$?
timeout 200 python3 probe.py grep 'partitions\enclave-app-hv80df703cb1442b-3f770400.log' --tail 8 --max 8 --pat ' |:' > logs-final2.json; echo rc=$?
