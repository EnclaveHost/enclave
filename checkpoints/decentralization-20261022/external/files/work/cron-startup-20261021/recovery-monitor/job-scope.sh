#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 200 python3 probe.py grep node.log --tail 2500 --max 20 --pat '38f368d6|owner-only|delegat|ownerSet|scope' --not 'config: bafkre' > recovery-monitor/node-scope-lines.json; echo rc=$?
