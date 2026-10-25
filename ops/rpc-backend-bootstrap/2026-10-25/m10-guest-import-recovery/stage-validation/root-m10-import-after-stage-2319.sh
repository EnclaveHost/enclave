#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
for i in $(seq 1 180); do
 if [ -f logs/root-m10-import-stage-2319.rc ]; then
  [ "$(cat logs/root-m10-import-stage-2319.rc)" = 0 ] || exit 1
  exec bash jobs/q-exit-status.sh root-m10-guest-native-2-2319 256 python3 finality-stage/m10-guest-import-recovery/host/guest-build-watch-2.py 2 1864c8526dd9487d5a07a12d311f8d887214fe85eed66eb9d9d8535e126b6d29 /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m10-guest-native-2
 fi
 sleep 5
done
exit 98
