#!/usr/bin/env bash
# transfer-relay-files.sh - ROOT runs this on its own workstation (ssh to both hosts), AFTER do-source-stop.sh --stop printed
# SOURCE STOPPED and 12-prepare-relay-dir.ps1 made the empty, protected target directory. The key and the stopped journal
# move by standard SFTP, remote to remote (transfer-lib.sh copy_create_only: scp -3 into unique hidden temporary names in
# the protected directory, host-side sha256 comparison, then a create-only rename). Nothing is written on this workstation;
# only "intact" / "MISMATCH" / a refusal is printed. An existing key or journal on the target is never overwritten. The
# source files stay in place (the protected rollback copies).
#   bash transfer-relay-files.sh us-west minipc
set -euo pipefail
cd "$(dirname "$0")"; . ./transfer-lib.sh
SRC=${1:?source ssh alias}; DST=${2:?target ssh alias}
TDIR='C:\ProgramData\Enclave\lease-relay'
ssh "${SSHOPT[@]}" "$SRC" "test -f /var/lib/enclave-lease-relay-migration/stop-receipt.json" || { echo "refused: the source has no stop receipt (run do-source-stop.sh --stop first)"; exit 2; }
copy_create_only "$SRC" linux /var/lib/enclave-lease-relay/relay.key "$DST" windows "$TDIR" relay.key
copy_create_only "$SRC" linux /var/lib/private/enclave-lease-relay-state/relay-send.json "$DST" windows "$TDIR" relay-send.json
echo "transferred; next on the target: 14-relay-migration-check.ps1"
