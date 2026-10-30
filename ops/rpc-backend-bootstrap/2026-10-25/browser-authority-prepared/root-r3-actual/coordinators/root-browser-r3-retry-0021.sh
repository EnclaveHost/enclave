#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
test "$(cat logs/root-browser-r3-unit-0020.rc)" = 99
bash jobs/q-exit-status.sh root-browser-r3-unit-retry-0021 1792 unshare -rn bash browser-authority-stage/r3/jobs/root-r3.sh
bash jobs/q-exit-status.sh root-browser-r3-build-0021 2560 unshare -rn env npm_config_offline=true npm_config_yes=false bash browser-authority-stage/r3/jobs/root-r3-build.sh
