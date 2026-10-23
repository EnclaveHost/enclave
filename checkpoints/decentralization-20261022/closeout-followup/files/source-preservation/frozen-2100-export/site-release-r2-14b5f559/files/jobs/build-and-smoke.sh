#!/bin/bash
set -euo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-site-release-r2-20261023
$S/tools/build-and-check.sh
$S/jobs/smoke.sh | tail -1
