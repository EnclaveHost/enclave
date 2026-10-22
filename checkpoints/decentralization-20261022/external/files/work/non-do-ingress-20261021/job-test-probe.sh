#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/non-do-ingress-20261021
timeout 120 python3 test_inbound_probe.py > test_inbound_probe.out 2>&1; echo rc=$?
