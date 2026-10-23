#!/bin/bash
set -euo pipefail
D=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-site-release-20261023
python3 -I $D/jobs/public-read.py > $D/evidence/public-read.json
cat $D/evidence/public-read.json
