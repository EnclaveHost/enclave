#!/bin/sh
# offline unit tests; run under: python3 work/claude-test-queue.py --mib 256 --log <guard> -- sh <this>
set -eu
cd "$(dirname "$0")/.."
exec python3 -u -m unittest -v test_l1_authority
