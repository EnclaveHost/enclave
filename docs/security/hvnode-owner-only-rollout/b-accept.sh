#!/usr/bin/env bash
# Acceptance of one B rollout step (enclave-87's list; bf reviews). Read-only: probes, public endpoints, hashes.
#   b-accept.sh 1 | 1b | 2 [off] | 3 [off]
# Every step: health.sh (KAT in the CURRENT invocation, the 3 canaries 200/0 on their guests' boot keys, us-west listed at
# 5.78.85.108, release ON for exactly the 3 canaries) + the step's own checks below. A check that could not be exercised
# says NOT EXERCISED, never passes silently.
set -uo pipefail; source "$(dirname "$0")/lib.sh"
STEP=${1:?usage: b-accept.sh 1|1b|2|3 [off]}; MODE=${2:-on}
ok=1; bad() { say "B ACCEPT $STEP $MODE FAIL: $*"; ok=0; }; note() { say "     $*"; }
bash "$H/health.sh" > $B/health-after-$STEP-$MODE.txt 2>&1; hr=$?; cat $B/health-after-$STEP-$MODE.txt; [ $hr = 0 ] || bad "health"
API=https://api.enclave.host
E=$(curl -sSf -m 20 $API/enclaves) || bad "/enclaves is not 200"
row() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); r=[e for e in d['enclaves'] if e.get('name')==sys.argv[2]]; print(json.dumps(r[0]) if len(r)==1 else '')" "$E" "$1"; }
field() { python3 -c "import json,sys; r=json.loads(sys.argv[1]) if sys.argv[1] else {}; v=r; exec('for k in sys.argv[2].split(\".\"): v = v.get(k) if isinstance(v, dict) else None'); print(json.dumps(v))" "$1" "$2"; }
NB=$(row nucbox-k11); ISO=$(row metal-iso0)
[ "$(field "$ISO" eligible)" = true ] || bad "metal-iso0 is not eligible"
if [ -n "$NB" ]; then
  [ "$(field "$NB" mode)" = '"hv-node"' ] && [ "$(field "$NB" eligible)" = false ] && [ "$(field "$NB" serving)" = false ] || bad "nucbox-k11 is not an ineligible, non-serving hv-node row: $NB"
else note "nucbox-k11 is not attached right now: its row checks NOT EXERCISED"; fi
curl -sSf -m 20 $API/v1/relays | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if not any(r.get('name')=='nucbox-k11' for r in d.get('relays',[])) else 1)" || bad "nucbox-k11 is in /v1/relays"
newinv() { local i0; i0=$(cat "$B/$1" 2>/dev/null || true); [ -n "$i0" ] && [ "$($NAN 'systemctl show enclave-api-relay -p InvocationID --value')" != "$i0" ] || bad "the api relay was not restarted by this step"; }
case "$STEP:$MODE" in
  1:on)
    newinv inv0-1.txt
    files_are_b "$NAN" api-relay.js tunnel.js host-delegation.mjs certs.js secrets.js fleet.mjs || bad "nan's relay files are not B's"
    files_are_b "$NR" relay.js fleet.mjs dns-relay.js || bad "nan-relay's relay files are not B's"
    [ -z "$NB" ] || [ "$(field "$NB" ownerOnly)" = null ] || bad "nucbox-k11 is owner-only before step 2"
    # the site: loads; every inline script's hash is in the live CSP (deploy.sh syncs them); the badge rule of B's pricing.js
    # on the LIVE rows: nucbox-k11 never a TEE GPU, metal-iso0's class unchanged by B
    html=$(curl -sSf -m 20 https://enclave.host/) || bad "the site does not load"
    csp=$(curl -sSI -m 20 https://enclave.host/ | tr -d '\r' | sed -n 's/^content-security-policy: //Ip')
    miss=$(python3 "$H/csp-check.py" "$csp" <<<"$html")
    [ -z "$miss" ] && note "site: 200, every inline script hash in the live CSP" || bad "inline script hash(es) missing from the live CSP: $miss"
    W=$(mktemp -d); git -C $MAIN show $BC:site/js/core/pricing.js > $W/pricing.mjs
    cls=$(node --input-type=module -e "import { enclaveClassOf } from '$W/pricing.mjs'; const d = JSON.parse(process.argv[1]); console.log(d.enclaves.filter((e) => ['nucbox-k11','metal-iso0'].includes(e.name)).map((e) => e.name + '=' + enclaveClassOf(e).kind).join(' '))" "$E"); rm -rf "$W"
    note "badge classes (B's pricing.js on the live rows): $cls"; ! grep -q "nucbox-k11=tee-gpu" <<<"$cls" || bad "nucbox-k11 would badge as a TEE GPU" ;;
  1b:on)
    files_are_b "$US" relay.js fleet.mjs connlog.mjs net-guard.mjs || bad "us-west's relay.js/fleet.mjs (or their import closure) are not B's"
    canaries_dns || bad "a canary is not 200 via us-west (DNS)"
    # test 1 on its PUBLIC hostname (enclave-87): 200, on the partition's pinned key, and the document there binds that handshake
    [[ "$TEST1_SPKI" =~ ^[0-9a-f]{64}$ ]] || bad "TEST1_SPKI is not pinned (64 hex): the key check cannot run"
    g=""; end=$(( $(date +%s) + 90 )); while [ "$(date +%s)" -lt $end ]; do g=$(public_get ${TEST1:2:8}); [[ "$g" == 200\ * ]] && break; sleep 10; done
    [ "$g" = "200 $TEST1_SPKI" ] && note "test 1 public: 200 on the partition's key ${TEST1_SPKI:0:16}" || bad "test 1 public: '$g' (want '200 ${TEST1_SPKI:0:16}...')"
    bd=$(public_doc_binds ${TEST1:2:8}); [ "$bd" = bound ] && note "test 1's attestation document binds the public handshake's key" || bad "test 1's document: $bd"
    # a hostname nothing may serve (a listed deployment with NO live lease, DNS at us-west): refused
    st=""; for d in $UNLEASED; do
      [ "$(curl -sS -m 20 "$API/v1/expected-guest?id=$d" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null)" = not_leased ] || continue
      [ "$(dig +short ${d:2:8}.app.enclave.host A | head -1)" = 5.78.85.108 ] || continue; st=$d; break; done
    [ -n "$st" ] || bad "no unleased us-west hostname to probe (all leased or not at us-west)"
    [ -z "$st" ] || { r=$(public_get ${st:2:8}); [ "$r" = "000 -" ] && note "an unleased hostname (${st:2:8}) is refused" || bad "the unleased ${st:2:8} answered '$r'"; } ;;
  2:on|2:off)
    newinv inv0-2-$MODE.txt
    if [ "$MODE" = on ]; then
      if [ "$(field "$NB" ownerOnly)" = true ]; then
        [ "$(field "$NB" operator)" = "\"$HVOP\"" ] || bad "the owner-only operator is not $HVOP"
        note "nucbox-k11 OWNER-ONLY: served $(field "$NB" served); serves $(field "$NB" servesDeployments)"
      else note "nucbox-k11 is not owner-only: its node has not attached with a v2 signature yet (b4's node change) - owner-only NOT EXERCISED"; fi
      # a stranger's deployment (a canary, owned by another wallet, leased to metal-iso0) on the nucbox splice path: refused
      st=$(curl -sS -o /dev/null -m 15 -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
             -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" "$API/t/nucbox-k11/x/${IDS%% *}/https")
      [ "$st" = 503 ] && note "a stranger's deployment on the nucbox splice path: 503" || bad "a stranger's deployment on the nucbox splice path answered $st, not 503"
      t1=$(field "$NB" servesDeployments | grep -o '0x31136008[0-9a-f]*' | head -1)
      if [ -n "$t1" ]; then r=$(curl -sS -o /dev/null -m 20 -w '%{http_code}/%{ssl_verify_result}' https://31136008.app.enclave.host/ 2>/dev/null); note "test 1 (${t1:0:10}) is served; its hostname answers $r (200/0 once d1's partition is up and us-west has B)"
      else note "test 1 (0x31136008) is not in the served list (not leased to nucbox-k11, or its owner/requirement): NOT EXERCISED"; fi
    else [ "$(field "$NB" ownerOnly)" = null ] || bad "nucbox-k11 is still owner-only after step 2 off"; fi ;;
  3:on|3:off)
    newinv inv0-3-$MODE.txt
    want=$([ "$MODE" = on ] && echo enforce || echo shadow)
    python3 - "$E" "$want" <<'PY' || bad "step 3's fleet view is not as expected"
import json, sys
d, want = json.loads(sys.argv[1]), sys.argv[2]
mode = (d.get("aggregate", {}).get("reverify") or {}).get("mode")
dialed = [e.get("name") or e.get("endpoint") for e in d["enclaves"] if not e.get("tunnel")]
print(f"     reverify mode {mode}; dialed rows {len(dialed)} {dialed}")
sys.exit(0 if mode == want and not dialed else 1)
PY
    [ -z "$NB" ] || note "nucbox-k11 still ineligible; owner-only $(field "$NB" ownerOnly)" ;;
  *) echo "usage: b-accept.sh 1|1b|2|3 [off]"; exit 2 ;;
esac
[ $ok = 1 ] && say "B STEP $STEP $MODE ACCEPTED" || { say "B STEP $STEP $MODE NOT ACCEPTED: roll back THIS step only (see README)"; exit 1; }
