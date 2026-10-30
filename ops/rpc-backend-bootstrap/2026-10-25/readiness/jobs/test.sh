#!/bin/bash
# Run inside `unshare -rn`: no external network, loopback only. Stdlib Python, no installs.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE"
ip link set lo up
export PYTHONDONTWRITEBYTECODE=1
python3 -c 'import sys; print(sys.version)'
sha256sum readiness_sampler.py test_readiness_sampler.py ../coverage/origin_extract.py
timeout -k 5 600 python3 -m unittest -v "${@:-test_readiness_sampler}"
