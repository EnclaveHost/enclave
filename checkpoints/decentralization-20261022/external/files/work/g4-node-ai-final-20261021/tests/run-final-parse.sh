#!/usr/bin/env bash
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021
echo "######## helper unit tests"; timeout 300 python3 -m unittest -v $P/helper/test_root_node_hold.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED"
echo "######## parse"; timeout 600 python3 $P/tools/parse-all.py; echo "parse rc=$?"
sha256sum $P/helper/root-node-hold.py $P/helper/node-hold-cutover.ps1
