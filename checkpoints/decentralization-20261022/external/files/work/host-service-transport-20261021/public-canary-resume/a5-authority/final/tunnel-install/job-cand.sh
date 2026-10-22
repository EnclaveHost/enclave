#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ; echo "== cleanup"; timeout 120 python3 cleanup-cand.py; echo "== candidate-check"; timeout 240 python3 tunnel_install.py minipc-candidate-check 2>&1 | tail -70; date -u +%FT%TZ
