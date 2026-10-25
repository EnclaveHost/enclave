#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
X=$PWD/finality-stage/m7-m10-combined-release
(cd "$X" && sha256sum -c --quiet SHA256SUMS)
python3 "$X/tools/make-watcher.py" --check "$X"
python3 -I "$X/tests/test-compound-gate.py"
python3 -I "$X/host/test-guest-release-watch.py"
echo 'ROOT COMBINED RELEASE PREPARATION TESTS PASS'
