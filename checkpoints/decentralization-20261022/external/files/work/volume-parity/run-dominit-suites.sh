#!/usr/bin/env bash
# The dominit suites that compile or read dominit.c, on the candidate tree: handoff, hardening, seccomp statement.
set -euo pipefail
cd "$(dirname "$0")/tree"
sh isolation/m2/test-dominit-handoff.sh
sh isolation/m2/test-dominit-hardening.sh
sh isolation/m2/test-seccomp-statement.sh
echo "DOMINIT SUITES: ALL EXITED 0"
