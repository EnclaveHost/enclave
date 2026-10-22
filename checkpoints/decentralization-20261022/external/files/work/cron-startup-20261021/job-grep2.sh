#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 300 python3 probe.py grep 'partitions\*.log' --tail 400 --max 80 --pat '[cron]|38f368d6|exited|status' > logs-grep2.json; echo rc=$?
timeout 400 python3 probe.py grep node.log --tail 120000 --max 60 --pat '0x38f368d6 launch|0x38f368d6 start|38f368d6 isolat|[cron]|38f368d6: the VM|38f368d6 partition|hv-node 0x38f368d6|38f368d6 vm' > logs-grep3.json; echo rc=$?
