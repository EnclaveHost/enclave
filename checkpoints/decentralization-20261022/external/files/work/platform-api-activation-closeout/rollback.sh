#!/bin/bash
# rollback.sh -- ROOT's rollback from the measured platform API group to the old minipc control-VM API. Prepared by the worker,
# NEVER executed by it. Default prints the plan for the given phase; nothing here deletes the old data directory.
#
#   rollback.sh before-switch   genesis may have run, DNS still points at the old API
#   rollback.sh after-switch    clients have written to the group
#
# Variables as in cutover.sh, plus for after-switch: RECOVERY_KEY (offline file), ARCHIVES (space-separated local copies of
# `latest` fetched from EVERY sink in platformApi.archives), RESTORE_DIR (new 0700 dir), MEMBER_CFG (any member config).
set -euo pipefail
H="$(cd "$(dirname "$0")" && pwd)/helpers"
case "${1:-}" in
before-switch) cat <<EOF
R1  Nothing on the old side changed: OLD_DATA_DIR was only read (export manifest \$WORK/export-manifest.json proves its tree digest).
R2  Verify the frozen copy still equals the cutover snapshot (OLD_DATA_DIR itself lacks the imported route-state, so verify the copy):
      ENCLAVE_TREE=\$TREE node $H/pa-export-check.mjs --verify \$WORK/data --manifest \$WORK/export-manifest.json   -> EQUAL
R3  Stop the member guests (root's launcher; their RAM state and K vanish with them; archives stay ciphertext). No member may run
    with credentials while the old API also runs: both hold SESSIONS_RELAYER_KEY / PROVISIONER_PRIVATE_KEY / Stripe keys.
R4  \$OLD_START_CMD. Done; no state moved.
EOF
;;
after-switch) cat <<EOF
R1  Point api.enclave.host back AWAY from the members (DNS owner) and wait TTL + 2*archiveMs, so in-flight writes land and are archived.
R2  Stop every member guest (the fence for the group: no further writes, no relayer or Stripe calls). Confirm via
    ENCLAVE_TREE=\$TREE node $H/pa-preflight.mjs ... -> every member unreachable.
R3  Fetch platform-api/<groupId>/latest from EVERY archive sink to local files (\$ARCHIVES); ciphertext, no key needed.
R4  OFFLINE, with a recovery private key:
      ENCLAVE_TREE=\$TREE node $H/pa-archive-open.mjs --member-config \$MEMBER_CFG --envelope \$WORK/recovery-envelope.json \\
        --recovery-key \$RECOVERY_KEY $(printf -- '--archive %s ' ${ARCHIVES:-A1 A2}) --materialize-to \$RESTORE_DIR
    -> newest head, its time, and the materialized tree digest. If it EQUALS export-manifest.json treeSha256 nothing was
       written since genesis: just do before-switch R4 on the untouched OLD_DATA_DIR.
R5  Otherwise move \$RESTORE_DIR onto the old box (an encrypted channel root already uses), keep OLD_DATA_DIR as-is beside it, set
    the old service's AUTH_DATA_DIR to the restored copy and its ROUTE_STATE_DIR to <restored>/route-state (the import put it
    there; likewise LEASE_GENERATION_STATE / FEATURED_VIEWS_FILE if \$WORK/imports.json lists them), then \$OLD_START_CMD.
R6  Loss bound, honestly: writes acknowledged by the group after its last archive and before R2 are lost (<= archiveMs if R1's
    wait was skipped; none if it held and no client wrote after it). In-memory challenges, rate limits, tunnels reset by design.
R7  Credentials rotated on the group (a later credentials package) are NOT in the old env: compare names with creds.json before R5.
EOF
;;
*) echo "usage: rollback.sh before-switch | after-switch" >&2; exit 2 ;;
esac
