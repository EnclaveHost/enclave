#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 400 python3 probe.py grep shield.log --tail 60000 --max 40 --pat 'hv1575e1ce5b9ffc|hv445e1c6b20f46e|hv80df703cb1442b' > logs-grep8.json; echo rc=$?
