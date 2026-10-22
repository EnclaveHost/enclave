#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-activation
timeout 300 python3 bundle-locate.py > bundle-locate.json; echo rc=$?
