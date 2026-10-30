#!/bin/bash
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 || exit 2
bash jobs/q-exit-status.sh root-combined-release-tests-2352 256 unshare -rn bash jobs/root-combined-release-tests-2352.sh > logs/root-combined-release-tests-2352.out 2>&1
r=$?; printf '%s\n' "$r" > logs/root-combined-release-tests-2352.rc
[ "$r" = 0 ] || exit "$r"
bash jobs/q-exit-status.sh root-combined-release-guest-2352 256 bash jobs/root-combined-release-launch-2352.sh > logs/root-combined-release-guest-2352.out 2>&1
r=$?; printf '%s\n' "$r" > logs/root-combined-release-guest-2352.rc
exit "$r"
