#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 400 python3 probe.py grep network.log --tail 8000 --max 30 --pat '38f368d6' > logs-grep10.json; echo rc=$?
timeout 200 python3 probe.py grep 'partitions\enclave-app-hv80df703cb1442b-3f770400.log' --tail 60 --max 12 --pat ' |:' > logs-grep11.json; echo rc=$?
