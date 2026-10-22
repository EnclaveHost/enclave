#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-activation
timeout 900 python3 activate.py preflight > preflight-receipt.out 2>&1; echo rc=$?
