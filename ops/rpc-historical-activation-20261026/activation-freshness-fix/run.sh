#!/bin/bash
set -euo pipefail
ip link set lo up
export PYTHONDONTWRITEBYTECODE=1 NODE=/usr/bin/node
export KZGCHECK=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/coverage-stage/kzgcheck/target/release/kzgcheck
python3 -B historical-activation-root-review/test_stale_activation.py
