#!/usr/bin/env bash
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H"; rc=0
./j4.sh > logs/j4.out 2>&1 || rc=1; grep -E "OK$|^overlay|^\[suite\]|^\[j5\]|﹣|✖" logs/j4.out | grep -v "failing tests"
./build-js.sh > logs/build-js.out 2>&1 || rc=1; grep -vE "^\s*$" logs/build-js.out | tail -16
./scan.sh > logs/scan.out 2>&1 || rc=1; tail -6 logs/scan.out
echo "[jfinal] rc=$rc"; exit $rc
