#!/usr/bin/env bash
# B step 3: RELAY_REVERIFY on nan's api relay (env-line-remote.sh: one line, one restart, instant rollback). on|off. Then b-accept.sh 3.
# Rollback = this script with off (then b-accept.sh 3 off).
set -euo pipefail; source "$(dirname "$0")/lib.sh"
MODE=${1:?usage: b-3-reverify.sh on|off}
PINS=$(for f in api-relay.js tunnel.js host-delegation.mjs certs.js secrets.js fleet.mjs; do echo "$f ${SHA[$f]}"; done)
if [ "$MODE" = on ]; then bash "$H/health.sh" > $B/health-before-3.txt 2>&1 || { cat $B/health-before-3.txt; say "REFUSING: not healthy before step 3"; exit 2; }; fi
trusted_digest > $B/trusted-before-3-$MODE.txt; $NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-3-$MODE.txt
say "B step 3 $MODE: RELAY_REVERIFY (TRUSTED_OPERATORS digest $(cat $B/trusted-before-3-$MODE.txt))"
set +e; $NAN "MODE=$MODE KEY=RELAY_REVERIFY VALUE=enforce STAMP=$(date -u +%Y%m%dT%H%M%SZ) PINS='$PINS' bash -s" < "$H/env-line-remote.sh" > $B/remote-3-$MODE.txt 2>&1; rc=$?; set -e
cat $B/remote-3-$MODE.txt; trusted_digest > $B/trusted-after-3-$MODE.txt
cmp -s $B/trusted-before-3-$MODE.txt $B/trusted-after-3-$MODE.txt || { say "B STEP 3: the TRUSTED_OPERATORS line CHANGED: STOP"; exit 9; }
say "B step 3 $MODE: remote rc=$rc; TRUSTED_OPERATORS unchanged ($(cat $B/trusted-after-3-$MODE.txt))$([ $rc = 0 ] && echo "; next: b-accept.sh 3 $MODE")"
exit $rc
