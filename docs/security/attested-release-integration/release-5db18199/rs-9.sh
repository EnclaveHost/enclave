#!/usr/bin/env bash
# rs-9 (enclave-87's hard order 09-26): the relay's predictor gets release 5db18199 (image 0c087de8, isolation/wx-at-attest) in ALL
# THREE lines BEFORE 63's tree switch: installed, admitted beside f7888d86, AND certifiable beside it (since cs-3 the cert set is
# explicit: a release outside it gives its guests NO certificate). Staged on nan by stage-release-keep3.sh at
# /opt/enclave-predict/rel-5db18199ef0d-b (sandboxed check PASS 05:12Z; cert set = {5db18199, f7888d86}; api-mcp-adapter
# c8ac2d72 under 5db18199 = 63's). This feeds ../three-line/rs3-remote.sh (bf GO) to nan: three lines, ONE api-relay restart.
#   rs-9.sh apply      PREDICT_RELEASES + 5db18199; DOMAIN_RELEASES = CERT_RELEASES = f7888d86,5db18199
#   rs-9.sh rollback   the three lines back (= the live lines at staging); only before any guest runs 5db18199
# No precondition on running guests (admitting beside f7888d86 cuts no guest off). rs-8's INSTANT predictor probe stays: a
# predictor problem right after the restart rolls this step back at once. Then: rs-9-accept.sh apply|rollback.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-9.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/rel-5db18199ef0d-b
NEW_SHA=e630e880799b5cc7e57df0fe494963204af9ff195b74d0452985b10acdee7e02   # predict-lines.env (staged 05:12:03-05:12:41Z, sandboxed check PASS)
OLD_SHA=34f409e4586ebb3021ed2582e5754c055ac08f5c90e3cf2e62d0424f4a8c8e15   # predict-lines.before.env (= the live three lines, key order)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs9-$MODE-inv0.txt"
say "rs-9 $MODE: the three release lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs9-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/../three-line/rs3-remote.sh" > "$RS/rs9-$MODE.txt" 2>&1; rc=$?; set -e
probe_predictor() {   # 0 predicting, 2 a predictor PROBLEM (predictor_unconfigured), 1 no answer in 120 s (enclave-5d S1)
  local end=$(( $(date +%s) + 120 )) b c
  while :; do
    b=$(curl -sS -m 40 -w '\n%{http_code}' "https://api.enclave.host/v1/expected-guest?id=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76" 2>/dev/null); c=${b##*$'\n'}; b=${b%$'\n'*}
    grep -q predictor_unconfigured <<<"$b" && { echo "PROBLEM: ${b:0:300}"; return 2; }
    [ "$c" = 200 ] && { echo "predicting (200)"; return 0; }
    [ "$(date +%s)" -ge $end ] && { echo "no answer in 120 s (last $c)"; return 1; }
    sleep 5
  done
}
cat "$RS/rs9-$MODE.txt"
# INSTANT predictor check (enclave-87 item 2): a problem right after the restart rolls this step back at once
if [ $rc = 0 ]; then
  p=$(probe_predictor); pr=$?; say "rs-9 $MODE: predictor probe: $p"
  if [ $pr = 2 ] && [ "$MODE" = apply ]; then say "rs-9 apply: a PREDICTOR PROBLEM after the restart: ROLLING BACK AT ONCE"; bash "$H/rs-9.sh" rollback; exit 9; fi
fi
say "rs-9 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-9-accept.sh $MODE")"
exit $rc
