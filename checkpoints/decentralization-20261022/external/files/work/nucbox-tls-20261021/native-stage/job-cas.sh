#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/native-stage
python3 test-activation.py > test-activation.out 2>&1; rc=$?; tail -3 test-activation.out; exit $rc
