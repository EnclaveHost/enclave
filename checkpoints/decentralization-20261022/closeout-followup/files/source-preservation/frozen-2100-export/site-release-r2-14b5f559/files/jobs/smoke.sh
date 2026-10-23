#!/bin/bash
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-site-release-r2-20261023
R=$(ls -d $S/release/b*)
timeout -k 5 240 node $S/tools/inert-smoke.mjs $R $S/check/release-check.json $S/check/inert-smoke.json
