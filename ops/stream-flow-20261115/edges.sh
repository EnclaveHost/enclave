#!/bin/bash
# The edge half of the stream-flow release: the standalone GameStream gateway on Enclave's four edges, replaced by the
# build of this checkout (bundle.sha256), in which a UDP association asks the app's front for a flow
# (network/wg-provider/port-flow.mjs). It is the 2026-11-14 activation (ops/gamestream-gateway-20261114/run.sh) with
# that folder's plan and this folder's bundle: same edges, same configuration, same checks; only the gateway's
# service restarts on each edge, the provider is not touched.
#
#   edges.sh preflight | activate | check | links | status | revert   [edge...]     as run.sh has them
#
# A front without flows (every desktop image before SVN22) answers the new gateway as it answered the old one: the
# plain tunnel. A stream that is running through an edge drops when its gateway restarts.
# Evidence goes outside the repository (it names the edges' addresses): $STREAM_FLOW_WORK/edges/.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
WORK=${STREAM_FLOW_WORK:-/home/steven/Documents/Codex/2026-10-23/it/work/stream-flow-20261115}
SHA=$(tr -d ' \n' < "$HERE/bundle.sha256"); [[ $SHA =~ ^[0-9a-f]{64}$ ]] || { echo "bundle.sha256 is not readable" >&2; exit 1; }
mkdir -p "$WORK/edges"
PLAN=$(mktemp "${TMPDIR:-/tmp}/enclave-stream-flow-plan.XXXXXX"); trap 'rm -f "${PLAN:?}"' EXIT
node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.bundle.sha256=process.argv[2];p.what+=" (stream-flow release, 2026-11-15)";fs.writeFileSync(process.argv[3],JSON.stringify(p))' \
  "$ROOT/ops/gamestream-gateway-20261114/plan.json" "$SHA" "$PLAN"
GSGW_PLAN=$PLAN GSGW_EVIDENCE=$WORK/edges bash "$ROOT/ops/gamestream-gateway-20261114/run.sh" "$@"
