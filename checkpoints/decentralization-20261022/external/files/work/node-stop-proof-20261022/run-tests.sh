#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PWSH="$(cd ../node-hold-package-20261021/tools/pwsh && pwd)/pwsh"
export N2_BASELINE="$(cd ../node-hold-package-20261021/helper && pwd)/node-hold-cutover.ps1"
python3 tools/preparation-test.py -v > preparation.out 2>&1
python3 tools/cutover-mock-test.py -v > suite.out 2>&1
cat preparation.out
cat suite.out
