#!/usr/bin/env bash
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H"; rc=0
./j1b.sh > logs/j1b.out 2>&1 || rc=1; grep -E "^\[suite\]|^\[j1b\]" logs/j1b.out
./j2.sh > logs/j2.out 2>&1 || rc=1; grep -E "^\[suite\]|^\[j2\]" logs/j2.out
./j3.sh > logs/j3.out 2>&1 || rc=1; grep -E "^\[suite\]|^\[j3\]" logs/j3.out
echo "[jrun] rc=$rc"; exit $rc
