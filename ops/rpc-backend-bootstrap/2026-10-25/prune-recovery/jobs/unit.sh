#!/bin/bash
# Launcher regression tests + repair-tool tests. Stdlib only, no network.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/source/ops/rpc-backend-bootstrap/2026-10-25
export PYTHONDONTWRITEBYTECODE=1
sha256sum $S/chain_service.py $S/test_chain_service.py $W/prune-recovery-stage/prune_profile_repair.py $W/prune-recovery-stage/test_prune_profile_repair.py $W/prune-recovery-stage/fixtures/*
cd $S && timeout -k 5 300 python3 -m unittest -v test_chain_service
cd $W/prune-recovery-stage && timeout -k 5 300 python3 -m unittest -v test_prune_profile_repair
