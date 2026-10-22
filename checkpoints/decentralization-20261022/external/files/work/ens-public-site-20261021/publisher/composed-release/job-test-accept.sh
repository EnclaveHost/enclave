#!/bin/bash
# OFFLINE fixture tests of the acceptance harness (no network)
set -uo pipefail
cd "/home/steven/Documents/Codex/2026-10-18/wo/work/ens-public-site-20261021/publisher/composed-release"
timeout 300 python3 test-accept.py > test-accept.out 2>&1; rc=$?
tail -1 test-accept.out; echo rc=$rc; exit $rc
