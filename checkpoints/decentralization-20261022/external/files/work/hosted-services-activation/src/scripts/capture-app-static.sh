#!/bin/bash
# PUBLIC-ONLY capture of the app zone's static platform labels (APP_STATIC) for stage @LABEL@: each documented label's A
# record from EVERY fleet authoritative nameserver (recursion off, AA required). A label is kept only when all servers
# agree on exactly one public address and it passes the route-dns role's validation; anything else is reported.
#   scripts/capture-app-static.sh > app-static.json      (then: build-stage-r2.mjs --app-static app-static.json)
# Labels: docs/security/secret-custody.md (custody-{us-west,ca-east,ap-southeast,eu-central}.app.enclave.host).
# Add a label ONLY from public documentation; never guess one (deployment-shaped labels are refused anyway).
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
labels=(custody-us-west custody-ca-east custody-ap-southeast custody-eu-central)
servers=(134.199.235.187 134.209.248.172 165.245.191.129 146.190.246.39)   # the four fleet nameservers (ns-<region>.enclave.host)
args=(); for l in "${labels[@]}"; do args+=(--label "$l"); done; for s in "${servers[@]}"; do args+=(--server "$s"); done
exec "$NODE" "$STAGE/bin/stage-tool.mjs" capture-app-static --zone app.enclave.host "${args[@]}"
