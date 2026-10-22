#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ; timeout 240 python3 tunnel_install.py minipc-candidate-check 2>&1 | tail -60; echo "== leftover check"; timeout 120 python3 cleanup-cand.py; date -u +%FT%TZ
