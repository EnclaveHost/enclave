#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config enclave-rpc 'sudo -n python3 -' < "$P/jobs/check-systemd-consumer-wiring.py"
