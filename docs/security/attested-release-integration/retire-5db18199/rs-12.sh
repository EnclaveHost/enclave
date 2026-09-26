#!/usr/bin/env bash
# rs-12 (the RETIRE of 5db18199, enclave-87 09-26): after 63's S9 (guestd onto R) and e8 (every canary relaunched on R aee2059f,
# ACCEPTED), 5db18199 leaves ALL THREE lines: not installed, not admitted, not certifiable - a guest on it gets neither secrets nor
# a certificate. Staged on nan by stage-retire3.sh at /opt/enclave-predict/retire-5db18199 (sandboxed check PASS 07:12Z: per canary
# version ONE release image AND ONE cert image, on R, at the pins). rs-10.sh (bf GO, run 06:28Z) with ONLY: DEST/hashes; the guard
# -> ./leased-attest.mjs (three-line/leased-attest-next.mjs, bf GO, with LISTED's pins retargeted to R); nucbox-k11's row recorded
# (rs-12-accept requires it back, 87's mid-soak rule); the release names; the rs12- names. rs-8's instant probe + rollback kept.
#   rs-12.sh apply      PREDICT_RELEASES = 5c3561f9, 6f14ce75 (KAT), aee2059f; DOMAIN_RELEASES = CERT_RELEASES = aee2059f
#   rs-12.sh rollback   the three lines back (= rs-11's: 5db18199 beside R in all three) - harmless (it re-admits only)
# Then: rs-12-accept.sh apply|rollback. ORDER (ROLLBACK.txt): a return to 5db18199 is rs-12's rollback FIRST, then S9's.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-12.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs12-lib.sh"
DEST=/opt/enclave-predict/retire-5db18199
NEW_SHA=a2d1da9f85ee26fd808acd1eb4480223e65a7820c8f192cb57728956f6700dcb   # predict-lines.env (staged 07:11:48-07:12:26Z, sandboxed check PASS)
OLD_SHA=6877d7de91c1f2e50f7701cefd8bb2b154b2efe8fcb15745a4288b6aed1cbc3d   # predict-lines.before.env (= the live three lines = rs-11's after)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# PRECONDITION of apply (rs-8's guard, retargeted): EVERY release-listed deployment holding a live lease (from the ledger) -
# the 3 canaries at least - runs on aee2059f, CHIP-VERIFIED from each serving guest's own report (./leased-attest.mjs: AMD
# chain, HOST_DATA, ABI/2 binding of our TLS handshake + fresh nonce + the admitted runtime, AppID, measurement = the pinned
# aee2059f value). A guest still on 5db18199 would lose its secrets and certificates: refused.
if [ "$MODE" = apply ]; then
  LISTED_IDS=$($NAN "grep -E '^SECRETS_RELEASE_DEPLOYMENTS=' /etc/nan-relay/api-relay.env | cut -d= -f2 | tr ',' ' '") \
  node "$H/leased-attest.mjs" "$H/../../../../relay" | tee "$RS/rs12-precondition.txt" || { say "REFUSING rs-12 apply: not every leased listed deployment is chip-verified on aee2059f"; exit 3; }
fi
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs12-$MODE-inv0.txt"
hv_row > "$RS/rs12-$MODE-hvrow0.txt"   # the NucBox's row before (rs-12-accept requires it back; 87's mid-soak rule)
say "rs-12 $MODE: the three release lines on nan, then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs12-$MODE-inv0.txt"))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA bash -s" < "$H/../three-line/rs3-remote.sh" > "$RS/rs12-$MODE.txt" 2>&1; rc=$?; set -e
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
cat "$RS/rs12-$MODE.txt"
# INSTANT predictor check (enclave-87 item 2): a problem right after the restart rolls this step back at once
if [ $rc = 0 ]; then
  p=$(probe_predictor); pr=$?; say "rs-12 $MODE: predictor probe: $p"
  if [ $pr = 2 ] && [ "$MODE" = apply ]; then say "rs-12 apply: a PREDICTOR PROBLEM after the restart: ROLLING BACK AT ONCE"; bash "$H/rs-12.sh" rollback; exit 9; fi
fi
say "rs-12 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-12-accept.sh $MODE")"
exit $rc
