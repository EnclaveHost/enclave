#!/usr/bin/env bash
# Probe Node abort/close semantics on loopback only. Immutable.
set -euo pipefail
HERE=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-control-attested
export PATH="$HERE/stubs:/usr/local/bin:/usr/bin:/bin"
unshare -r -n bash -c "ip link set lo up; exec node $HERE/probe-abort.mjs"
