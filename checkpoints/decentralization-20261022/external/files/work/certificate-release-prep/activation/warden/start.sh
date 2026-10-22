#!/bin/bash
# Root: start (not enable) the staged challenge service, then wait for its health.  sudo bash start.sh <label>
set -euo pipefail
systemctl start enclave-challenge-host.service
for i in $(seq 1 60); do curl -fsS http://127.0.0.1:18254/health >/dev/null 2>&1 && break; sleep 2; done
bash "$(dirname "$0")/health.sh" "$1"
