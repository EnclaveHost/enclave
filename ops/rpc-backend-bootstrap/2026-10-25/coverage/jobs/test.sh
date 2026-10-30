#!/bin/bash
# Run inside `unshare -rmn` (no network; private mount namespace for the read-only bind).
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
ip link set lo up
export KZGCHECK=$HERE/kzgcheck/target/release/kzgcheck PYTHONDONTWRITEBYTECODE=1
timeout -k 5 900 python3 -m unittest -v test_origin_extract test_coverage_gate
bash jobs/real-origin.sh
