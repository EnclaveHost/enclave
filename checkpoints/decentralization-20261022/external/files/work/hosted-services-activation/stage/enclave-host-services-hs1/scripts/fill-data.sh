#!/bin/bash
# Fill stage hs1's PUBLIC data (root-owned, read-only to the service) under the installed data root:
#   scripts/fill-data.sh artifacts --from-dir <dir with <cid>.bin/.car> [--from-dir ...] [--from-origin http://<replica>:8189 ...]
#       every object of the installed bootstrap manifest, copied opaquely, kept only after its sha256 matches
#   scripts/fill-data.sh policy [--carrier https://<mirror>/platform-policy ...]
#       the CURRENTLY anchored admin-signed policy, verified at a fresh agreed block; an unanchored book writes nothing
# Extra options (--rpc, --book, --host-ownership) pass through to bin/stage-tool.mjs.
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
[ -f "$RECEIPT" ] || die "stage $LABEL is not installed (no $RECEIPT)"
what=${1:-}; shift || true
case "$what" in
  artifacts) exec "$NODE" "$OPT/bin/stage-tool.mjs" fill-artifacts --manifest "$DATA/bootstrap-manifest.json" --dir "$DATA/artifacts" "$@" ;;
  policy) exec "$NODE" "$OPT/bin/stage-tool.mjs" policy-import --import-dir "$DATA/policy-import" "$@" ;;
  *) die "usage: fill-data.sh artifacts|policy [options]" 1 ;;
esac
