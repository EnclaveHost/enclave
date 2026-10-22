#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 200 python3 probe.py list > logs-list.json; echo rc=$?
