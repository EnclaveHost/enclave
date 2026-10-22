#!/usr/bin/env bash
# user-transfer.sh - the operator user runs this on warden-host AFTER eu-source-stop.sh --stop printed SOURCE STOPPED on
# eu-central (root, its own tested script) and user-stage.sh --stage printed STAGED here. The stopped journal and the key
# move from the source (ssh as its authorized root alias) into this user's empty 0700 state directory by the opaque
# create-only copy (user-transfer-lib.sh). Only "intact" / "MISMATCH" / a refusal is printed. The source files stay in place.
#   bash user-transfer.sh eu-central
# Order and markers - the rule "the source never restarts from a stale journal after the target ever ran" (the source's
# eu-source-restore.sh reads exactly these markers):
#   1. preconditions: the source's stop receipt and NO earlier transfer marker; here the staging receipt, an EMPTY state
#      directory owned by this user, no unit file or mask link, and no target-ever-started marker;
#   2. transfer-begun is written create-only ON THE SOURCE before any byte moves;
#   3. the JOURNAL is copied first, then the KEY (a target holding the key always holds its journal);
#   4. only if the key verifiably did not arrive (no final file, no temporary copy here) is transfer-key-not-delivered
#      written on the source, which alone re-allows the source's --abort-before-transfer.
# A second run refuses (the marker exists): a failed transfer is settled by the runbook's rollback, never a silent retry.
set -euo pipefail
cd "$(dirname "$0")"; . ./user-common.sh; . ./user-transfer-lib.sh
SRC=${1:?source ssh alias}; [ $# -eq 1 ] || { echo "usage: user-transfer.sh <source alias>"; exit 2; }
need_user
SR=${SRC_FSROOT:-}; [ -z "$SR" ] || echo "** TEST source root (SRC_FSROOT set): not a production run **"
SMIG=$SR/var/lib/enclave-lease-relay-migration
SKEY=$SR/var/lib/enclave-lease-relay/relay.key
SSTATE=$SR/var/lib/private/enclave-lease-relay-state/relay-send.json

_rx "$SRC" "test -f $SMIG/stop-receipt.json" || { echo "refused: the source has no stop receipt (run eu-source-stop.sh --stop there first)"; exit 2; }
_rx "$SRC" "! test -e $SMIG/transfer-begun" || { echo "refused: a transfer already began from this source: settle it by the runbook's rollback, never by a retry"; exit 2; }
[ -f "$MIG/staging-receipt.json" ] || { echo "refused: this target is not staged (user-stage.sh --stage)"; exit 2; }
chain_ok "$DIR" && owned_dir "$DIR" && dir_empty "$DIR" || { echo "refused: $DIR is not an empty 0700 directory of this user under an owned path"; exit 2; }
[ ! -e "$UNIT_PATH" ] && [ ! -L "$UNIT_PATH" ] && [ ! -e "$EVER_STARTED" ] || { echo "refused: the role is installed, masked or has run here"; exit 2; }
"$NODE" "$(RELEASE)/verify-release.mjs" >/dev/null || { echo "refused: the staged release does not verify"; exit 2; }

_rx "$SRC" "set -o noclobber; echo \"\$(date -u +%FT%TZ) to the user target $(id -un)@$(hostname)\" > $SMIG/transfer-begun" || { echo "refused: the transfer marker could not be written on the source; nothing was copied"; exit 1; }
echo "transfer marker written on the source: from now on it restarts only from this target's returned journal"
journal "transfer begun from $SRC"
key_absent() { [ ! -e "$KEY" ] && ! ls -A "$DIR" | grep -q '^\.incoming-relay\.key-'; }
nothing() {
  journal "transfer FAILED: $1"
  if key_absent; then _rx "$SRC" "set -o noclobber; echo \"\$(date -u +%FT%TZ) $1\" > $SMIG/transfer-key-not-delivered" && echo "the key did NOT reach this target (verified); recorded on the source: eu-source-restore.sh --abort-before-transfer is allowed there"
  else echo "the key MAY be here: do not abort the source; follow the runbook (user-out-of-service.sh, user-journal-back.sh, eu-source-restore.sh --after-target-start)"; fi
  exit 1; }
copy_from_source "$SRC" "$SSTATE" "$DIR" relay-send.json || nothing "journal copy failed"
copy_from_source "$SRC" "$SKEY" "$DIR" relay.key || nothing "key copy failed"
journal "transferred (journal, then key)"
echo "transferred (journal, then key); next here: bash user-activate.sh --check, then --activate"
