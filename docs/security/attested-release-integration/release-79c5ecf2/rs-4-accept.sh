#!/usr/bin/env bash
# rs-4 live acceptance. apply: the api-relay restarted by rs-4 (a new invocation, 0 restarts after); its predictor's KAT PASS
# in THAT invocation's journal (cold: up to 15 min); accept.sh with ADMIT=79c5ecf2 (each canary's own measurement predicted,
# AND 79c5ecf2 predicted and admitted for it: the tree switch's precondition; the release OFF (503); 404/422); for every
# canary the installed set is exactly {5c3561f9, 6f14ce75, a4f22748, 79c5ecf2} and ONLY 79c5ecf2 admitted; MemoryPeak
# under 1536M; /enclaves 200; the canaries' public TLS unchanged; metal-iso0 serving and eligible.
# rollback: the same with a4f22748 admitted and 79c5ecf2 not installed.
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$RS/rollout.log"; } 2>/dev/null || true; }
MODE=${1:?usage: rs-4-accept.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
R5=5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2; R6=6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb
RA=a4f227482df4830ab69b52e38dc5d6e2abea9e5c5fb71f5469f0c30e6b1cb784; R7=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4
case $MODE in apply) ADM=$R7; SET="$R5 $R6 $RA $R7" ;; rollback) ADM=$RA; SET="$R5 $R6 $RA" ;; *) echo "apply|rollback"; exit 2 ;; esac
ok=1; bad() { say "RS-4 ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }
as=$(prop ActiveState); nr=$(prop NRestarts); inv=$(prop InvocationID); inv0=$(cat "$RS/rs4-$MODE-inv0.txt" 2>/dev/null || true)
say "api-relay: $as, NRestarts $nr, invocation ${inv:0:12} (before rs-4: ${inv0:0:12})"
[ "$as" = active ] && [ "$nr" = 0 ] || bad "the api-relay is not active, or restarted"
[ -n "$inv0" ] && [ "$inv" != "$inv0" ] || bad "the api-relay was not restarted by rs-4"
end=$(( $(date +%s) + 900 )); kat=""
while [ "$(date +%s)" -lt $end ]; do
  kat=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'known-answer test at start'" || true)
  [ -n "$kat" ] && break; sleep 15
done
say "KAT: ${kat:-none after 15 min}"; [[ "$kat" == *"PASS: 2 known answer(s)"* ]] || bad "no KAT PASS"
ADMIT=$ADM bash "$H/../accept.sh" > "$RS/rs4-$MODE-accept.txt" 2>&1; ar=$?; cat "$RS/rs4-$MODE-accept.txt"; [ $ar = 0 ] || bad "accept.sh (ADMIT=${ADM:0:12}) rc=$ar"
for cid in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
  eg=$(curl -sS --max-time 60 "https://api.enclave.host/v1/expected-guest?id=$cid" || true)
  python3 -c '
import json, sys
r = json.loads(sys.argv[1]); want = set(sys.argv[3].split()); im = r.get("images", [])
got = {i["release"] for i in im}; adm = {i["release"] for i in im if i.get("releaseAdmitted") is True}
sys.exit(0 if got == want and adm == {sys.argv[2]} else 1)' "$eg" "$ADM" "$SET" 2>/dev/null \
    && say "ok   ${cid:0:10}: installed = the expected $(wc -w <<<"$SET") releases; admitted = ${ADM:0:12} only" \
    || bad "${cid:0:10}: the installed/admitted sets are not the expected ones: ${eg:0:300}"
done
peak=$(prop MemoryPeak); say "MemoryPeak $peak"; [[ "$peak" =~ ^[0-9]+$ ]] && [ "$peak" -lt $((1536*1024*1024)) ] || bad "MemoryPeak $peak"
[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.enclave.host/enclaves)" = 200 ] || bad "/enclaves is not 200"
wait_for 120 public_ok || bad "the canaries do not serve with their keys"
relay_row_ok || bad "metal-iso0 is not serving and eligible"
[ $ok = 1 ] && say "RS-4 $MODE ACCEPTED" || { say "RS-4 $MODE NOT ACCEPTED$([ "$MODE" = apply ] && echo ': rollback = rs-4.sh rollback, then rs-4-accept.sh rollback')"; exit 1; }
