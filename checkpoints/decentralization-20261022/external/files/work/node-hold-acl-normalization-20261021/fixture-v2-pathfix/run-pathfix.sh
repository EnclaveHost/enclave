#!/usr/bin/env bash
# fixture-v2-pathfix: local only (fake transport / plan mode); never a remote or native call
cd /home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-acl-normalization-20261021/fixture-v2-pathfix || exit 1; rc=0
echo "######## path fix: W, actual transport path + sha, only-diff, plan mode no remote"
timeout 120 python3 -m unittest -v test_pathfix 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "######## the 11 reviewed v2 driver/local tests on the fixed copy"
timeout 300 python3 -m unittest -v test_local_v2 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error" ; [ ${PIPESTATUS[0]} -eq 0 ] || rc=1
echo "RESULT rc=$rc"; exit $rc
