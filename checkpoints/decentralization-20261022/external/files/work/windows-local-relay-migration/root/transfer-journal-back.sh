#!/usr/bin/env bash
# transfer-journal-back.sh - ROLLBACK B (after the target started): ROOT runs this on its workstation AFTER 95-rollback-relay.ps1
# printed OUT OF SERVICE. The target's send record (the key's journal since the move) goes back to the source as
# relay-send.json.from-windows by the same create-only SFTP copy (transfer-lib.sh). It refuses unless the Windows relay is
# verifiably out of service (task \Enclave\Relay disabled or absent, nothing listening on 8549). Nothing is printed but
# "intact" / "MISMATCH" / a refusal. Then on the source: do-source-restore.sh --after-target-start --windows-out-of-service <gate>.
#   bash transfer-journal-back.sh minipc us-west
set -euo pipefail
cd "$(dirname "$0")"; . ./transfer-lib.sh
WIN=${1:?target (Windows) ssh alias}; SRC=${2:?source ssh alias}
out=$(_ps "$WIN" "\$t = Get-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Relay' -ErrorAction SilentlyContinue; \$l = @(Get-NetTCPConnection -State Listen -LocalPort 8549 -ErrorAction SilentlyContinue).Count; if ((-not \$t -or \$t.State -eq 'Disabled') -and \$l -eq 0) { 'out-of-service' } else { 'IN SERVICE' }")
[ "$out" = out-of-service ] || { echo "refused: the Windows relay is not verifiably out of service ($out): run 95-rollback-relay.ps1 first"; exit 2; }
copy_create_only "$WIN" windows 'C:\ProgramData\Enclave\lease-relay\relay-send.json' "$SRC" linux /var/lib/private/enclave-lease-relay-state relay-send.json.from-windows
echo "journal returned; next on the source: do-source-restore.sh --after-target-start --windows-out-of-service <gate.mjs>"
