#!/usr/bin/env bash
# Step 3: SECRETS_RELEASE_CERT_RELEASES = the admitted release (f7888d86), read ON nan from DOMAIN_RELEASES (cs-3-remote.sh),
# one api-relay restart, >=10 min after the last (the NucBox soak). on|off. Then cs-3-accept.sh (which runs `off` at once if
# the predictions come out wrong). ROLLBACK ORDER: this line off BEFORE any rs-8 rollback (a cert set without an admitted
# release is a predictor problem).
set -euo pipefail; source "$(dirname "$0")/lib.sh"
MODE=${1:?usage: cs-3-env.sh on|off}
PINS=$(for f in api-relay.js secrets-release.mjs measurement-predict.mjs; do echo "$f ${SHA[$f]}"; done)
if [ "$MODE" = on ]; then
  age=$(last_restart_age); [ "$age" -ge 600 ] || { say "REFUSING: the api relay restarted ${age}s ago (< 10 min: the NucBox soak)"; exit 2; }
  bash "$HEALTH" > $B/health-before-3.txt 2>&1 || { cat $B/health-before-3.txt; say "REFUSING: not healthy before step 3"; exit 2; }
fi
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > $B/inv0-3-$MODE.txt
say "step 3 $MODE: SECRETS_RELEASE_CERT_RELEASES (= the admitted ${RF:0:8}, read on nan)"
set +e; $NAN "MODE=$MODE EXPECT=$RF STAMP=$(date -u +%Y%m%dT%H%M%SZ) PINS='$PINS' bash -s" < "$H/cs-3-remote.sh" > $B/remote-3-$MODE.txt 2>&1; rc=$?; set -e
cat $B/remote-3-$MODE.txt; say "step 3 $MODE: remote rc=$rc"
[ $rc = 0 ] || exit $rc
# chained (enclave-87 item 2): no human gap between the restart and the check; on: a problem rolls the line back at once
[ "$MODE" = on ] && exec bash "$H/cs-3-accept.sh" on
exit 0
