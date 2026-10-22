#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/non-do-ingress-20261021
timeout 300 python3 observe.py > observe.out 2>&1; echo rc=$?
