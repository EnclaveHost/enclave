#!/usr/bin/env bash
# LOCAL ONLY: the frozen canary's real `plan` on the final controller/receiver pair + root's transport. No network.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/tunnel-system-canary-review-20261021
date -u +%FT%TZ; sha256sum frozen/g1_canary.py manifest-final.json
G1_RUNS=$PWD/runs G1_SIZES=1 timeout 120 python3 frozen/g1_canary.py plan --manifest manifest-final.json --offset-min 2; echo "plan rc=$?"
date -u +%FT%TZ
