#!/usr/bin/env bash
# LOCAL ONLY: the PROPOSED canary copy's real `plan` on the final pair (sizes incl. the real-system invariants). No network.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/tunnel-system-canary-review-20261021
date -u +%FT%TZ; sha256sum proposed/g1_canary.py manifest-final.json
G1_RUNS=$PWD/runs-proposed G1_SIZES=1 timeout 120 python3 proposed/g1_canary.py plan --manifest manifest-final.json --offset-min 2 | python3 -c "import sys,json;t=sys.stdin.read();print(t[-700:])"; echo "plan rc=${PIPESTATUS[0]}"
date -u +%FT%TZ
