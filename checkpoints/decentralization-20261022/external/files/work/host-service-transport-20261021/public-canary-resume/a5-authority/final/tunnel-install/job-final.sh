#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ
for c in pin minipc-preflight vm-preflight minipc-candidate-check; do echo "===== $c"; timeout 240 python3 tunnel_install.py $c 2>&1 | tail -45; done
echo "===== leftover"; timeout 120 python3 cleanup-cand.py
date -u +%FT%TZ
