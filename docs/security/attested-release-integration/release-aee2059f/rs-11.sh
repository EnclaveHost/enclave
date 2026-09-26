#!/usr/bin/env bash
# rs-11: the combined SNP relay window (enclave-87 09-26, from 63's N2 plan abb87c12). ONE api-relay restart for:
#   rs-11  release R = aee2059f (image 4cd26e58, bf GO, independently rebuilt) in ALL THREE lines beside 5db18199 (installed,
#          admitted, certifiable); staged by stage-release-keep3.sh at /opt/enclave-predict/rel-aee2059ffcc7 (sandboxed check
#          PASS 06:57Z: a69dcbba's version admitted = {5db18199 c8ac2d72, R 5be51185}; cert set {5db18199, R});
#   N1-a   METAL_ALLOWED_MEASUREMENTS + N1 b2dba54a (node image 2492e683, 5d GO);
#   N2-a   + N2 fab9c6c7 (node image 6845565a, d1 GO); every live entry KEPT, in order (02f6e313 = f6cbd75a: N2-b's rollback).
# rs-9.sh with ONLY: the pins (rs11-lib.sh); the remote -> ../three-line/rs4-remote.sh (four lines, allow_ok) with ADD; the S8
# guard replaced by rs-11's rollback guards (rs11-lib.sh rollback_guard: the node on N1/N2, S9 run, or an unreadable node);
# nucbox-k11's row recorded before (rs-11-accept requires it back). rs-8's INSTANT probe + immediate rollback kept.
#   rs-11.sh apply      the four lines; ONE restart
#   rs-11.sh rollback   the four lines back (the guards above; OVERRIDE=<reason> to pass them)
# Then: rs-11-accept.sh apply|rollback.
set -euo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
MODE=${1:?usage: rs-11.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs11-lib.sh"
if [ "$MODE" = rollback ]; then
  m=$(node_meas metal-iso0); why=$(rollback_guard "$m") || {
    [ -n "${OVERRIDE:-}" ] || { echo "REFUSING rs-11 rollback: $why (or OVERRIDE=<reason>)"; exit 4; }
    echo "rs-11 rollback past its guard, overridden: $OVERRIDE ($why)"; }
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
$NAN "systemctl show enclave-api-relay -p InvocationID --value" > "$RS/rs11-$MODE-inv0.txt"
hv_row > "$RS/rs11-$MODE-hvrow0.txt"; date +%s > "$RS/rs11-$MODE-t0.txt"   # the box's row, and the time it goes off the relay
say "rs-11 $MODE: the four lines on nan (R's three + the node allowlist), then one api-relay restart (invocation before: $(cut -c1-12 "$RS/rs11-$MODE-inv0.txt"); $HV: $(cat "$RS/rs11-$MODE-hvrow0.txt" | cut -c1-40))"
set +e; $NAN "MODE=$MODE DEST=$DEST STAMP=$STAMP NEW_SHA=$NEW_SHA OLD_SHA=$OLD_SHA ADD=$ADD bash -s" < "$H/../three-line/rs4-remote.sh" > "$RS/rs11-$MODE.txt" 2>&1; rc=$?; set -e
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
cat "$RS/rs11-$MODE.txt"
# INSTANT predictor check (enclave-87 item 2): a problem right after the restart rolls this step back at once
if [ $rc = 0 ]; then
  p=$(probe_predictor); pr=$?; say "rs-11 $MODE: predictor probe: $p"
  # the apply-time rollback: nothing can depend on the additions yet (the node cannot attach on N1/N2, nor S9 build on R, before them)
  if [ $pr = 2 ] && [ "$MODE" = apply ]; then say "rs-11 apply: a PREDICTOR PROBLEM after the restart: ROLLING BACK AT ONCE"; OVERRIDE="the apply-time rollback, seconds after the apply" bash "$H/rs-11.sh" rollback; exit 9; fi
fi
say "rs-11 $MODE: remote rc=$rc$([ $rc = 0 ] && echo "; next: rs-11-accept.sh $MODE")"
exit $rc
