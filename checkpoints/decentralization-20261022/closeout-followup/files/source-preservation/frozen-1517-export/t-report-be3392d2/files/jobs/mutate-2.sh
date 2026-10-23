#!/bin/bash
# Final control run on the final commits (doubles as the final full integration run) + the G4b mutant.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-hdd-storage-compose-20261023
timeout -k 10 1500 python3 -u jobs/mutate.py G4b-assemble-ignores-nonempty-mountpoint-both-checks
