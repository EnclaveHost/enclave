#!/usr/bin/env bash
# transfer-to-warden.sh - ROOT runs this on its workstation (ssh as root to both hosts) AFTER eu-source-stop.sh --stop printed
# SOURCE STOPPED on eu-central and warden-stage.sh --stage printed STAGED on warden. The stopped journal and the key move by
# the established opaque copy (transfer-lib.sh copy_create_only, byte-identical to the us-west -> minipc one: scp -3 SFTP
# into unique hidden temporary names in the protected directory, host-side sha256 comparison, create-only rename). Nothing
# is written on this workstation; only "intact" / "MISMATCH" / a refusal is printed. The source files stay in place.
#   bash transfer-to-warden.sh eu-central warden
# Order and markers (the rule "the source never restarts from a stale journal after the target ever ran"):
#   1. preconditions: the source's stop receipt; NO earlier transfer marker there; on warden the staging receipt, an EMPTY
#      state directory, no unit file, and no target-ever-started marker;
#   2. $TRANSFER_BEGUN is written create-only ON THE SOURCE before any byte moves. From then on eu-source-restore.sh refuses
#      --abort-before-transfer (the key may run on warden) and accepts only warden's returned journal;
#   3. the JOURNAL is copied first, then the KEY: a target holding the key always holds its journal;
#   4. if the key did NOT arrive (no final file and no temporary copy on warden, verified), $TRANSFER_NOTHING is written on
#      the source: the key never left, so --abort-before-transfer is allowed again (the journal copy alone is inert: the
#      role has no unit and no key there).
# A second run refuses (the marker exists): a failed transfer is settled by the rollback, never by a silent retry.
set -euo pipefail
cd "$(dirname "$0")"; . ./transfer-lib.sh
SRC=${1:?source ssh alias}; DST=${2:?warden ssh alias}
# TEST ONLY: path prefixes for the isolated tests (mock ssh/scp run on this machine); production never sets them
SR=${SRC_FSROOT:-}; DR=${DST_FSROOT:-}; [ -n "$SR$DR" ] && echo "** TEST ROOTS (SRC_FSROOT/DST_FSROOT set): not a production run **"
SMIG=$SR/var/lib/enclave-lease-relay-migration
SKEY=$SR/var/lib/enclave-lease-relay/relay.key
SSTATE=$SR/var/lib/private/enclave-lease-relay-state/relay-send.json
DMIG=$DR/var/lib/enclave-host-relay-migration
DDIR=$DR/var/lib/private/enclave-host-relay/lease-relay
DUNIT=$DR/etc/systemd/system/enclave-host-relay.service

_lx "$SRC" "test -f $SMIG/stop-receipt.json" || { echo "refused: the source has no stop receipt (run eu-source-stop.sh --stop first)"; exit 2; }
_lx "$SRC" "! test -e $SMIG/transfer-begun" || { echo "refused: a transfer already began from this source ($SMIG/transfer-begun): settle it by the runbook's rollback, never by a retry"; exit 2; }
_lx "$DST" "test -f $DMIG/staging-receipt.json" || { echo "refused: warden has no staging receipt (run warden-stage.sh --stage first)"; exit 2; }
_lx "$DST" "test -d $DDIR && test -z \"\$(ls -A $DDIR)\"" || { echo "refused: warden's $DDIR is absent or not empty"; exit 2; }
_lx "$DST" "! test -e $DUNIT && ! test -L $DUNIT && ! test -e $DMIG/target-ever-started" || { echo "refused: the role is installed or has run on warden"; exit 2; }

_lx "$SRC" "set -o noclobber; echo \"\$(date -u +%FT%TZ) to $DST\" > $SMIG/transfer-begun" || { echo "refused: the transfer marker could not be written on the source; nothing was copied"; exit 1; }
echo "transfer marker written on the source: from now on it restarts only from warden's returned journal"
key_absent() { _lx "$DST" "! test -e $DDIR/relay.key && ! ls -A $DDIR | grep -q '^\.incoming-relay\.key-'"; }
nothing() {   # the key verifiably did not reach warden: record it on the source (create-only), then stop
  if key_absent; then _lx "$SRC" "set -o noclobber; echo \"\$(date -u +%FT%TZ) $1\" > $SMIG/transfer-key-not-delivered" && echo "the key did NOT reach warden (verified); recorded on the source: eu-source-restore.sh --abort-before-transfer is allowed"
  else echo "the key MAY be on warden: do not abort; follow the runbook (warden-out-of-service.sh, transfer-journal-back.sh, eu-source-restore.sh --after-target-start)"; fi
  exit 1; }
copy_create_only "$SRC" linux "$SSTATE" "$DST" linux "$DDIR" relay-send.json || nothing "journal copy failed"
copy_create_only "$SRC" linux "$SKEY" "$DST" linux "$DDIR" relay.key || nothing "key copy failed"
echo "transferred (journal, then key); next on warden: sudo bash warden-activate.sh --check, then --activate"
