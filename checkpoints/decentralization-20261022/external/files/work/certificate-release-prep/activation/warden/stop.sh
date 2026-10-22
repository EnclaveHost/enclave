#!/bin/bash
# Root: stop the challenge service; prove its three ports are free. No file is changed.  sudo bash stop.sh
set -euo pipefail
systemctl stop enclave-challenge-host.service
for p in 18253 18254 18443; do ss -Hltnu "( sport = :$p )" | grep -q . && { echo "port $p still listening"; exit 1; }; done
echo STOPPED
