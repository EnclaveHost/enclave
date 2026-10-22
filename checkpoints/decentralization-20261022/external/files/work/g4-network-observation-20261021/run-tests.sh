#!/usr/bin/env bash
# g4-network-observation: local fixture tests only (transport replaced; no remote)
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-network-observation-20261021 || exit 1
timeout 120 python3 -m unittest -v test_observe 2>&1; rc=$?; rm -rf __pycache__; echo "RESULT rc=$rc"; exit $rc
