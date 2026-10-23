#!/bin/bash
# P's own unit suite on the re-vendored composed P clone (p/), offline netns; then the byte-level render diff vs vm-3.
set -u
C=$(cd "$(dirname "$0")/.." && pwd)
bash $C/p/jobs/run.sh unit; rc=$?
python3 -I $C/jobs/render-diff.py; rc2=$?
echo "p-unit rc=$rc render-diff rc=$rc2"; [ $rc -eq 0 ] && [ $rc2 -eq 0 ]
