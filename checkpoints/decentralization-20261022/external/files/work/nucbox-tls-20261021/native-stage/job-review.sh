#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/nucbox-tls-20261021/native-stage
python3 test-review.py > test-review.out 2>&1; rc=$?; tail -2 test-review.out
python3 ../root-activate.py --parse-only > parse-only.out 2>&1; rc2=$?; tail -4 parse-only.out; echo "review_rc=$rc parse_rc=$rc2"; [ $rc -eq 0 ] && [ $rc2 -eq 0 ]
