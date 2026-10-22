#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 500 python3 probe.py grep node.log --tail 150000 --max 40 --pat 'secrets delivered to 0x38f368d6|38f368d6 isolation spawned|38f368d6 restart recovery|secrets for 0x38f368d6|38f368d6: secrets|38f368d6 secrets' > logs-grep7.json; echo rc=$?
