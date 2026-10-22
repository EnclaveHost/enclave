#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-activation
timeout 700 python3 preflight.py > preflight.json; echo rc=$?
