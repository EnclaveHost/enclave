#!/usr/bin/env bash
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021
node "$H/reconstruct-config-r5.mjs"
echo "pin-only rewrite == r5 gen-config: $(cmp -s "$H/upgrade-bundle-r5/config/host-services.json" "$H/bundle-input/host-services.r5-genconfig.json" && echo YES || echo NO)"
"$H/runner-smoke-r5.sh"
