#!/bin/bash
# Build host: create the pinned bundle for the completed M7 artifact (once), then run guest-smoke.sh exactly as the guest will.
#   python3 work/claude-test-queue.py --mib 256 --log $A/logs/host-smoke.guard -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
#     HOME=/nonexistent unshare -rn bash $A/host-smoke.sh > $A/logs/host-smoke.out 2>&1
set -uo pipefail
A=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/base-runtime-abi
B=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build/out-1/base
H=5aa7b2919870950f1dd90249d3900730184e3ce6b5a54048b3dbca2a72ef430c; BD=$A/bundle-${H:0:12}
if [ -e "$BD" ]; then echo "[info] bundle exists: reusing after verification"; (cd "$BD" && sha256sum -c --quiet SHA256SUMS) || { echo "## bundle damaged"; exit 1; }
else python3 -I $A/abi.py bundle "$B" --expect-sha $H --out "$BD" --name base || { echo "## bundle refused"; exit 1; }; fi
SUMS=$(sha256sum < "$BD/SHA256SUMS" | cut -c1-64); echo "[pin] bundle SHA256SUMS $SUMS"
mkdir -p $A/home; HOME=$A/home bash $A/guest-smoke.sh $A $H $SUMS
