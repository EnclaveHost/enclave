#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-activation
timeout 200 python3 live-support.py > live-support.json; echo rc=$?
