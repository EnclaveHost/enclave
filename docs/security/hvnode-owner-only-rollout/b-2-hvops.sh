#!/usr/bin/env bash
# B step 2: RELAY_HVNODE_OPERATORS on nan's api relay (env-line-remote.sh: one line, one restart, instant rollback). on|off. Then b-accept.sh 2.
# Rollback = this script with off (then b-accept.sh 2 off).
set -euo pipefail; source "$(dirname "$0")/lib.sh"
MODE=${1:?usage: b-2-hvops.sh on|off}
PINS=$(for f in api-relay.js tunnel.js host-delegation.mjs certs.js secrets.js fleet.mjs; do echo "$f ${SHA[$f]}"; done)
if [ "$MODE" = on ]; then bash "$H/health.sh" > $B/health-before-2.txt 2>&1 || { cat $B/health-before-2.txt; say "REFUSING: not healthy before step 2"; exit 2; }; fi
trusted_digest > $B/trusted-before-2-$MODE.txt; $NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-2-$MODE.txt
say "B step 2 $MODE: RELAY_HVNODE_OPERATORS (TRUSTED_OPERATORS digest $(cat $B/trusted-before-2-$MODE.txt))"
set +e; $NAN "MODE=$MODE KEY=RELAY_HVNODE_OPERATORS VALUE=$HVOP STAMP=$(date -u +%Y%m%dT%H%M%SZ) PINS='$PINS' bash -s" < "$H/env-line-remote.sh" > $B/remote-2-$MODE.txt 2>&1; rc=$?; set -e
cat $B/remote-2-$MODE.txt; trusted_digest > $B/trusted-after-2-$MODE.txt
cmp -s $B/trusted-before-2-$MODE.txt $B/trusted-after-2-$MODE.txt || { say "B STEP 2: the TRUSTED_OPERATORS line CHANGED: STOP"; exit 9; }
say "B step 2 $MODE: remote rc=$rc; TRUSTED_OPERATORS unchanged ($(cat $B/trusted-after-2-$MODE.txt))$([ $rc = 0 ] && echo "; next: b-accept.sh 2 $MODE")"
exit $rc
