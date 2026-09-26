#!/usr/bin/env bash
# Step 3 acceptance, enclave-87 and 5d's required checks. on:
#   1. a new api-relay invocation, 0 restarts; the known-answer test PASS at start in it (it runs ONLY when the predictor has no
#      problems, so a problem - e.g. a cert set without the admitted release - shows as no PASS line);
#   2. every canary's /v1/expected-guest lists ONLY f7888d86, admitted, at its pin (the admitted release predicts; no
#      5c3561f9/6f14ce75 image, so a guest on a KAT-only release gets no certificate: bf's negative, on live leased deployments);
#   3. health (CERT_SEPARATE=1).
# A failure of 1 or 2 rolls the line back AT ONCE (cs-3-env.sh off), enclave-87: a wrong refusal must not stand.
# off: the new invocation and the KAT; the canaries' expected guests list the KAT releases again (health in its default mode).
set -uo pipefail; source "$(dirname "$0")/lib.sh"
MODE=${1:-on}; ok=1; bad() { say "STEP 3 ACCEPT FAIL: $*"; ok=0; }
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); nr=$($NAN "systemctl show enclave-api-relay -p NRestarts --value")
[ "$inv" != "$(cat $B/inv0-3-$MODE.txt 2>/dev/null)" ] && [ "$nr" = 0 ] || bad "not a clean single restart (${inv:0:12}, NRestarts $nr)"
end=$(( $(date +%s) + 900 )); kat=""
while [ "$(date +%s)" -lt $end ]; do kat=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'known-answer test at start'" || true); [ -n "$kat" ] && break; sleep 15; done
say "KAT: ${kat:-none after 15 min (a predictor PROBLEM refuses every prediction)}"; [[ "$kat" == *"PASS: 2 known answer(s)"* ]] || bad "no KAT PASS at start"
if [ "$MODE" = on ]; then
  CERT_SEPARATE=1 bash "$HEALTH" > $B/health-after-3.txt 2>&1; hr=$?; cat $B/health-after-3.txt; [ $hr = 0 ] || bad "health / the expected guests"
  if [ $ok != 1 ]; then say "STEP 3: ROLLING THE LINE BACK AT ONCE"; bash "$H/cs-3-env.sh" off; exit 1; fi
else
  bash "$HEALTH" > $B/health-after-3-off.txt 2>&1; hr=$?; cat $B/health-after-3-off.txt; [ $hr = 0 ] || bad "health after off"
fi
[ $ok = 1 ] && say "STEP 3 $MODE ACCEPTED" || { say "STEP 3 $MODE NOT ACCEPTED"; exit 1; }
