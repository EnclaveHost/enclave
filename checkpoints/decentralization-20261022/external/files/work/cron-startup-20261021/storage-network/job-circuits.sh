#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021
timeout 300 python3 probe.py grep network.log --tail 6000 --max 40 --pat 'qualif|b123e685|153dc6fa|egress OFF|egress back|no circuit|no qualified|provider' --not 'policy requires the current lease' > storage-network/circuit-lines.json; echo rc=$?
