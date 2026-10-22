#!/usr/bin/env bash
# user-journal-back.sh - ROLLBACK step 2 (the operator user, on warden-host) AFTER user-out-of-service.sh printed TARGET OUT
# OF SERVICE. This target's send record - the key's journal since the move - goes back to eu-central as
# relay-send.json.from-target by the opaque create-only copy (user-transfer-lib.sh). It refuses unless this target is out of
# service NOW (masked, inactive, no process, nothing on :8549) and its journal is still the one the receipt recorded.
# Next, on eu-central (root): eu-source-restore.sh --after-target-start --target-out-of-service <gate.mjs>
#   bash user-journal-back.sh eu-central
set -euo pipefail
cd "$(dirname "$0")"; . ./user-common.sh; . ./user-transfer-lib.sh
SRC=${1:?source ssh alias}; [ $# -eq 1 ] || { echo "usage: user-journal-back.sh <source alias>"; exit 2; }
need_user
SR=${SRC_FSROOT:-}; [ -z "$SR" ] || echo "** TEST source root (SRC_FSROOT set): not a production run **"
r=$MIG/out-of-service-receipt.json
masked_link "$UNIT_PATH" && [ "$(show ActiveState)" != active ] && ! relay_process && ! listener && [ -f "$r" ] && owned_file "$STATE" \
  && grep -q "\"stateSha256\":\"$(sha "$STATE")\"" "$r" || { echo "refused: this target is not verifiably out of service with the receipt's journal (run user-out-of-service.sh first)"; exit 2; }
copy_to_source "$SRC" "$STATE" "$SR/var/lib/private/enclave-lease-relay-state" relay-send.json.from-target
journal "journal returned to $SRC"
echo "journal returned; next on the source (root): eu-source-restore.sh --after-target-start --target-out-of-service <gate.mjs>"
