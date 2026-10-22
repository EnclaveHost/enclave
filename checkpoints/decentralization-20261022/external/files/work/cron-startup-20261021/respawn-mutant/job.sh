#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-mutant
timeout 1500 python3 test-respawn.py > mutant.out 2>&1; echo mutant rc=$?
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/respawn-activation
timeout 1500 python3 test-respawn.py > test-respawn.out 2>&1; echo real rc=$?
