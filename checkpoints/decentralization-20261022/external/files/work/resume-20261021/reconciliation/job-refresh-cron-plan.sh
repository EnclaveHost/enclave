#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/reconciliation
timeout 900 python3 refresh-cron.py --plan > refresh-cron-plan.out 2>&1; echo rc=$?
