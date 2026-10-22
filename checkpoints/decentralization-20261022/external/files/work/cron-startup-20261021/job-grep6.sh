#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 500 python3 probe.py grep node.log --tail 60000 --max 50 --pat '38f368d6' --not 'no ready partition' > logs-grep6.json; echo rc=$?
