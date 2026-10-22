#!/bin/bash
# Roll stage hs1 back to exactly the pre-install state, touching ONLY what install.sh recorded in its receipt:
#   stop and disable this one unit; remove its state (systemctl clean); remove each installed file whose bytes are still
#   what install.sh wrote (a changed file is KEPT and reported, exit 4); remove the unit file, the stage directories and
#   the data root (artifacts and the imported policy were filled under it). No other unit, file, service or provider
#   setting is touched. Stage 1 published nothing (no advertisement, no DNS delegation): there is no public rollback.
#   scripts/rollback.sh [--keep-data] [--keep-state]
set -euo pipefail
STAGE=$(cd "$(dirname "$0")/.." && pwd)
. "$STAGE/scripts/common.sh"
keep_data=no; keep_state=no
for a in "$@"; do case "$a" in --keep-data) keep_data=yes ;; --keep-state) keep_state=yes ;; *) die "unknown option $a" 1 ;; esac; done
[ -f "$RECEIPT" ] || die "no install receipt ($RECEIPT): nothing of stage $LABEL to roll back"
receipt=$(mktemp); cp "$RECEIPT" "$receipt"; trap 'rm -f "$receipt"' EXIT
"$SYSTEMCTL" stop "$UNIT_NAME" || true
"$SYSTEMCTL" disable "$UNIT_NAME" 2>/dev/null || true
if [ $keep_state = no ]; then "$SYSTEMCTL" clean --what=state "$UNIT_NAME" || echo "warning: systemctl clean failed; state of $UNIT_NAME left in place" >&2; fi
modified=0
while read -r kind a b; do
  [ "$kind" = file ] || continue
  [ "$b" = "$RECEIPT" ] && continue
  if [ ! -e "$b" ]; then continue; fi
  if [ "$(sha256sum "$b" | cut -d' ' -f1)" = "$a" ]; then rm -f "$b"; else echo "KEPT (changed since install): $b" >&2; modified=1; fi
done < "$receipt"
"$SYSTEMCTL" daemon-reload
"$SYSTEMCTL" reset-failed "$UNIT_NAME" 2>/dev/null || true
if [ $keep_data = no ]; then rm -rf "$DATA/artifacts" "$DATA/policy-import"; fi
if [ $modified = 0 ]; then rm -f "$RECEIPT"; fi
# directories install.sh created, deepest first; removed only when empty (nothing of anyone else is deleted)
tac "$receipt" | while read -r kind a _; do [ "$kind" = dir ] && [ -d "$a" ] && find "$a" -depth -type d -empty -delete 2>/dev/null; done; true
echo "rolled back stage $LABEL$( [ $keep_data = yes ] && echo ' (data kept)')$( [ $keep_state = yes ] && echo ' (state kept)')"
exit $(( modified * 4 ))
