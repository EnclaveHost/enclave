#!/usr/bin/env bash
# ONE serial job: helper unit tests, the cutover-script scenario mocks, the PowerShell parse of every remote text, and the
# package suites on mirror-new. Each part bounded.
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021
echo "######## helper unit tests"; timeout 300 python3 -m unittest -v $P/helper/test_root_node_hold.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED"
echo "######## cutover scenario mocks (pwsh 7, Linux)"; timeout 600 python3 -m unittest -v $P/tools/cutover-mock-test.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED|Error:"
echo "######## parse"; timeout 600 python3 $P/tools/parse-all.py; echo "parse rc=$?"
echo "######## package suites"; $P/tests/run-package-suites.sh
echo "######## variant B bundle"; $P/build/build-network-variantB.sh
echo "######## pins"; sha256sum $P/helper/root-node-hold.py $P/helper/node-hold-cutover.ps1 $P/control/new/*.mjs $P/build/out/candidate/*.mjs
