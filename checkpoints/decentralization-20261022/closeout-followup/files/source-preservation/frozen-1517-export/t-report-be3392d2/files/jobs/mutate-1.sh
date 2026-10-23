#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-hdd-storage-compose-20261023
timeout -k 10 3300 python3 -u jobs/mutate.py
