#!/bin/bash
# PUBLIC-ONLY capture for root, before install (reads no env file, private config, database or key):
#   node version and path; this host's listening sockets (ss); one agreed block of public Base state for this host's
#   registry endpoint (registry entry, platform policy anchor, book owner, service-index code); whether the anchored
#   policy document can be fetched and verified now (dry run: nothing written).
#   scripts/capture-public-inputs.sh [registry endpoint]   (default: the endpoint in config/host-services.json)
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
TOOL="$STAGE/bin/stage-tool.mjs"
endpoint=${1:-$("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).host.endpoint' "$STAGE/config/host-services.json")}
pin=$(mktemp); trap 'rm -f "$pin"' EXIT
"$NODE" -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(c.serviceIndex))' "$STAGE/config/host-services.json" > "$pin"
echo "== node: $(command -v "$NODE") $("$NODE" --version)"
echo "== listeners (ss -Hltnu)"; ss -Hltnu
echo "== public chain facts"; "$NODE" "$TOOL" capture-public --endpoint "$endpoint" --index-pin "$pin"
echo "== anchored policy (dry run)"; "$NODE" "$TOOL" policy-import --import-dir /nonexistent-dry-run --dry-run
