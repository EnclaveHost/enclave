#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-activation
timeout 400 python3 activate.py bundle-inspect --new-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > bundle-inspect.out 2>&1; echo rc=$?
