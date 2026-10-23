#!/bin/bash
set -uo pipefail
N=/home/steven/Documents/Codex/2026-10-18/wo/work/custody-v2-site-release-r2-20261023
$N/tools/focused.sh a942a61fde4a07e6237b859f6ca5f0e1e22e8c33 new; a=$?
$N/tools/focused.sh 2d3839c547bba10d31339a8f165425571782dddc prior; b=$?
echo "new=$a prior=$b"; [ $a -eq 0 ] && [ $b -ne 0 ]
