#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")"; . ./lib2.sh
capacity_gate || exit 9
run_ps harness/w9-debug.ps1 120 results-w9/debug.out; cat results-w9/debug.out
