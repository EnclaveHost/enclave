#!/usr/bin/env bash
# rs-10 (the RETIRE of f7888d86, enclave-87's hard order 09-26): after 63's S8 switch and every running guest relaunched on
# 5db18199, f7888d86 leaves ALL THREE lines: not installed, not admitted, not certifiable - a guest on it gets neither secrets
# nor a certificate. Staged on nan by stage-retire3.sh at /opt/enclave-predict/retire-f7888d86 (sandboxed check PASS 05:25Z:
# per canary version ONE release image AND ONE cert image, on 5db18199, at the pins). rs-8.sh with ONLY: the remote ->
# ../three-line/rs3-remote.sh (bf GO), DEST/hashes, the guard retargeted (./leased-attest.mjs: every leased listed deployment
# chip-verified on 5db18199). rs-8's instant probe + immediate rollback kept.
#   rs-10.sh apply      PREDICT_RELEASES = 5c3561f9, 6f14ce75 (KAT), 5db18199; DOMAIN_RELEASES = CERT_RELEASES = 5db18199
#   rs-10.sh rollback   the three lines back (= rs-9's: f7888d86 beside 5db18199 in all three) - harmless (it re-admits only)
# Then: rs-10-accept.sh apply|rollback.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-10.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
DEST=/opt/enclave-predict/retire-f7888d86
NEW_SHA=03e0ccf11246b77fc54d3a31c87ea48c3a10bc06853dba7037d8280dbb836780   # predict-lines.env (staged 05:25:06-05:25:44Z, sandboxed check PASS)
OLD_SHA=e630e880799b5cc7e57df0fe494963204af9ff195b74d0452985b10acdee7e02   # predict-lines.before.env (= the live three lines = rs-9's after)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# PRECONDITION of apply (rs-8's guard, retargeted): EVERY release-listed deployment holding a live lease (from the ledger) -
# the 3 canaries at least - runs on 5db18199, CHIP-VERIFIED from each serving guest's own report (./leased-attest.mjs: AMD
# chain, HOST_DATA, ABI/2 binding of our TLS handshake + fresh nonce + the admitted runtime, AppID, measurement = the pinned
# 5db18199 value). A guest still on f7888d86 would lose its secrets and certificates: refused.
if [ "$MODE" = apply ]; then
  LISTED_IDS=$($NAN "grep -E '^SECRETS_RELEASE_DEPLOYMENTS=' /etc/nan-relay/api-relay.env | cut -d= -f2 | tr ',' ' '") \
  node "$H/leased-attest.mjs" "$H/../../../../relay" | tee "$RS/rs10-precondition.txt" || { say "REFUSING rs-10 apply: not every leased listed deployment is chip-verified on 5db18199"; exit 3; }
fi
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs10-$MODE-inv0.txt"
say "rs-10 $MODE: the three release lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs10-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/../three-line/rs3-remote.sh" > "$RS/rs10-$MODE.txt" 2>&1; rc=$?; set -e
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
cat "$RS/rs10-$MODE.txt"
# INSTANT predictor check (enclave-87 item 2): a problem right after the restart rolls this step back at once
if [ $rc = 0 ]; then
  p=$(probe_predictor); pr=$?; say "rs-10 $MODE: predictor probe: $p"
  if [ $pr = 2 ] && [ "$MODE" = apply ]; then say "rs-10 apply: a PREDICTOR PROBLEM after the restart: ROLLING BACK AT ONCE"; bash "$H/rs-10.sh" rollback; exit 9; fi
fi
say "rs-10 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-10-accept.sh $MODE")"
exit $rc
