#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/challenge-host-tls-20261021/g4 && python3 root-hs2-g4.py --selfcheck > selfcheck.out 2>&1; echo "exit=$?" >> selfcheck.out; rm -rf __pycache__
