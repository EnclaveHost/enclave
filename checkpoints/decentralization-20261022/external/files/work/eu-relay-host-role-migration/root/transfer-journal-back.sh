#!/usr/bin/env bash
# transfer-journal-back.sh - ROLLBACK step 2 (root's workstation) AFTER warden-out-of-service.sh printed TARGET OUT OF
# SERVICE. Warden's send record (the key's journal since the move) goes back to eu-central as relay-send.json.from-target by
# the same create-only SFTP copy (transfer-lib.sh). It refuses unless warden is verifiably out of service NOW (masked,
# inactive, no role process, nothing on :8549, the out-of-service receipt present) and its journal is still the one that
# receipt recorded. Nothing is printed but "intact" / "MISMATCH" / a refusal.
# Next, on eu-central: sudo bash eu-source-restore.sh --after-target-start --target-out-of-service <gate.mjs>
#   bash transfer-journal-back.sh warden eu-central
set -euo pipefail
cd "$(dirname "$0")"; . ./transfer-lib.sh
DST=${1:?warden ssh alias}; SRC=${2:?source ssh alias}
SR=${SRC_FSROOT:-}; DR=${DST_FSROOT:-}; [ -n "$SR$DR" ] && echo "** TEST ROOTS (SRC_FSROOT/DST_FSROOT set): not a production run **"
DMIG=$DR/var/lib/enclave-host-relay-migration
DSTATE=$DR/var/lib/private/enclave-host-relay/lease-relay/relay-send.json
DUNIT=$DR/etc/systemd/system/enclave-host-relay.service
out=$(_lx "$DST" "test -L $DUNIT && [ \"\$(readlink $DUNIT)\" = /dev/null ] && [ \"\$(systemctl show -p ActiveState --value enclave-host-relay.service)\" != active ] \
  && ! pgrep -f 'lease-relay-host\.mjs|packages/lease-relay\.mjs' >/dev/null && ! ss -Hltn 'sport = :8549' | grep -q . && test -f $DMIG/out-of-service-receipt.json \
  && grep -q \"\\\"stateSha256\\\":\\\"\$(sha256sum $DSTATE | cut -c1-64)\\\"\" $DMIG/out-of-service-receipt.json && echo out-of-service" || true)
[ "$out" = out-of-service ] || { echo "refused: warden is not verifiably out of service with the receipt's journal (run warden-out-of-service.sh first)"; exit 2; }
copy_create_only "$DST" linux "$DSTATE" "$SRC" linux "$SR/var/lib/private/enclave-lease-relay-state" relay-send.json.from-target
echo "journal returned; next on the source: sudo bash eu-source-restore.sh --after-target-start --target-out-of-service <gate.mjs>"
