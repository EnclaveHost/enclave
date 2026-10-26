#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh root-browser-r3-unit-0020 512 unshare -rn bash browser-authority-stage/r3/jobs/root-r3.sh
bash jobs/q-exit-status.sh root-browser-r3-build-0020 2560 unshare -rn env npm_config_offline=true npm_config_yes=false bash browser-authority-stage/r3/jobs/root-r3-build.sh
