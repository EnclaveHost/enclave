#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/repo"
npm ci --offline --ignore-scripts --no-audit --no-fund --loglevel=warn
(cd relay && npm ci --offline --ignore-scripts --no-audit --no-fund --loglevel=warn)
echo "NPM CI OFFLINE: OK"
