#!/bin/bash
# Start stage @LABEL@ (NOT enable: a reboot does not start it until root enables it). Then wait for health.
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
[ -f "$RECEIPT" ] || die "stage $LABEL is not installed"
[ -n "$(ls -A "$DATA/artifacts" 2>/dev/null)" ] || die "no artifacts: run scripts/fill-data.sh artifacts first"
"$SYSTEMCTL" start "$UNIT_NAME"
exec "$STAGE/scripts/health.sh" --wait "${HEALTH_WAIT:-600}"
