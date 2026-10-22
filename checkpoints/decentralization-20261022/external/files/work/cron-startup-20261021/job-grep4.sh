#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 200 python3 probe.py grep 'partitions\enclave-app-hv1575e1ce5b9ffc-3f770400.log' --tail 200 --max 80 --pat ' |:' > logs-grep4.json; echo rc=$?
timeout 500 python3 probe.py grep node.log --tail 200000 --max 40 --pat 'did not serve|i32 exit|exited with|stderr|function 84|wasm trap|VSOCK' > logs-grep5.json; echo rc=$?
