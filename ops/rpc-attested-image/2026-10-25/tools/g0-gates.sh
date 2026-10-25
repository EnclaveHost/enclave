#!/usr/bin/env bash
# g0 (queue 1024): fresh independent clones at $C, then the bundle gates: p2 (all 5 rebuilt == committed, builder --check)
# and p4 (dependency-ordered fixed point on both clones, A == B, no file changes vs $C).
set -uo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-image-stage
bash $B/tools/c0-clone.sh || exit 1
echo "##### p2"; bash $B/tools/p2-rebuild.sh 0235e7d96 final || exit 1
echo "##### p4"; bash $B/tools/p4-fixpoint.sh || exit 1
