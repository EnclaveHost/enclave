#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 500 python3 probe.py grep node.log shield.log network.log --tail 40000 --max 60 > logs-grep1.json; echo rc=$?
