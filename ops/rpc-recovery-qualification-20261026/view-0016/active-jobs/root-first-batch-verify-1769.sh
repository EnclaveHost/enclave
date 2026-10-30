#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
B=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-multipart-production-20261026
cd "$P"
# This watches exactly the already-started copy job, never resumes a copy.
for ((i=0;i<720;i++)); do
  if [[ -f logs/rmp-r3-batch-0001-0008-copy-1762.rc ]]; then break; fi
  sleep 15
done
[[ $(cat logs/rmp-r3-batch-0001-0008-copy-1762.rc) == 0 ]] || { echo 'Copy did not finish successfully; verification not started'; exit 4; }
bash jobs/q-exit-status.sh rmp-r3-batch-0001-0008-verify-1769 1024 bash recovery-multipart-stage/r3/jobs/root-preservation.sh "$B/verify-request.json" 1728b7b67c9718fb2ca673c2e865914df0ed393a777d3e138bdd593496839cfa "$B/manifest.json" f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9 verify 1-8
