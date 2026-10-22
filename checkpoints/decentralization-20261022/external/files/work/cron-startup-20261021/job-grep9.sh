#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 300 python3 probe.py grep 'partitions\enclave-app-hv80df703cb1442b-3f770400.log' 'partitions\enclave-app-hv445e1c6b20f46e-3f770400.log' --tail 400 --max 60 --pat ' |:' > logs-grep9.json; echo rc=$?
