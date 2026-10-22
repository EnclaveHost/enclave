#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")"; . ./lib2.sh
capacity_gate || exit 9
run_ps harness/fail-probe.ps1 120 results-w9/fail-probe.out; cat results-w9/fail-probe.out
