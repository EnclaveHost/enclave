#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
sourcefile=wrapper-pruned-identity-stage/overlay/wrapper/chain_service.py
expected=6a4d7aa5da385bf1d8dea74c37060eb1332d5d468625d54ae02ae878c7135189
[ "$(sha256sum "$sourcefile" | cut -d' ' -f1)" = "$expected" ]
echo "Read-only live l1-ready, source $expected; no install/start/restart"
timeout 240 ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config -o BatchMode=yes -o ConnectTimeout=10 enclave-rpc 'sudo -n /usr/bin/python3 -I - l1-ready' < "$sourcefile"
[ "$(sha256sum "$sourcefile" | cut -d' ' -f1)" = "$expected" ]
