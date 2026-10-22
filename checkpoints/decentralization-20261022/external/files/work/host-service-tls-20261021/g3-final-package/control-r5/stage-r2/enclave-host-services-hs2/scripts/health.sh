#!/bin/bash
# Stage-1 health of stage hs2: the unit, a FRESH decision of the unchanged platform host policy gate for this host,
# the four roles, served artifacts, real DNS answers and the policy mirror. Exit 0 healthy, 2 unhealthy.
#   scripts/health.sh [--wait SECONDS] [--artifacts all] [--json]
set -uo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
wait=0; extra=()
while [ $# -gt 0 ]; do case "$1" in --wait) wait=$2; shift 2 ;; *) extra+=("$1"); shift ;; esac; done
if [ "${SKIP_UNIT_CHECK:-0}" != 1 ]; then
  "$SYSTEMCTL" is-active --quiet "$UNIT_NAME" || { echo "FAIL  unit $UNIT_NAME is not active"; "$SYSTEMCTL" status --no-pager "$UNIT_NAME" | head -20; exit 2; }
  "$SYSTEMCTL" show -p ActiveState -p NRestarts -p MemoryCurrent -p MemoryPeak -p MemoryMax -p CPUQuotaPerSecUSec -p TasksCurrent "$UNIT_NAME"
fi
cfg=$(prefixed_config); trap 'rm -f "$cfg"' EXIT
deadline=$(( $(date +%s) + wait ))
while :; do
  "$NODE" "$OPT/bin/stage-tool.mjs" health --config "$cfg" ${extra[@]+"${extra[@]}"} && exit 0
  [ "$(date +%s)" -lt "$deadline" ] || exit 2
  echo "(not healthy yet; retrying in 10 s)"; sleep 10
done
