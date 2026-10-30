#!/bin/sh
# Real pinned binary, loopback-only netns, fake 404 beacon/EL. Run under the shared queue at 512 MiB.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/witness-failover/bin/helios-eeffcc9
SHA=cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0
OUT="$HERE/../runs/binary-probe"
exec unshare -rn sh -c "ip link set lo up && exec python3 -u '$HERE/binary_probe.py' '$BIN' '$SHA' '$OUT'"
