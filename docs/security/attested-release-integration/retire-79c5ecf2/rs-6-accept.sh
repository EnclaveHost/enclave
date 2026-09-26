#!/usr/bin/env bash
# rs-6 (the RETIRE edit) live acceptance, enclave-87's list. apply:
#   1. the api-relay restarted by rs-6 (a new invocation, 0 restarts after); the KAT PASS in THAT invocation (on 5c3561f9 and
#      6f14ce75, both still installed);
#   2. accept.sh with ADMIT=52156652: the canaries' own 09-24 measurements predicted (under the KAT releases), 52156652
#      predicted and admitted, 404, 422, and exactly one FAIL, the release-ticket 403 (= the release ON);
#      accept.sh with ADMIT=79c5ecf2 and with ADMIT=a4f22748: REFUSED for every canary (3 canary FAIL lines + the 403 line);
#   3. for every canary: installed = {5c3561f9, 6f14ce75, 52156652} (neither 79c5ecf2 nor a4f22748 predicted for a
#      certificate); admitted = {52156652} only, at the independently derived measurement (63's = mine);
#   4. release ON for exactly the 3 canaries; MemoryPeak; /enclaves 200; the canaries 200/0 on their guests' boot keys; us-west
#      listed; metal-iso0 serving and eligible.
# rollback: rs-5's state (all five installed, 79c5ecf2 and 52156652 admitted).
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$RS/rollout.log"; } 2>/dev/null || true; }
MODE=${1:?usage: rs-6-accept.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
R5=5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2; R6=6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb
RA=a4f227482df4830ab69b52e38dc5d6e2abea9e5c5fb71f5469f0c30e6b1cb784; R7=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4
RN=52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1
case $MODE in apply) ADM="$RN"; SET="$R5 $R6 $RN"; REFUSED="$R7 $RA" ;; rollback) ADM="$R7 $RN"; SET="$R5 $R6 $RA $R7 $RN"; REFUSED="" ;; *) echo "apply|rollback"; exit 2 ;; esac
# the measurements: 79c5ecf2's = the live predictions the canaries run (4e MATCH); 52156652's = 63's independent values
declare -A M7=([0x0ddbd824]=2317370df6562d5b03f2b4b78c297e0b14cf81cc0e53704f893e86dc305bf397e92233b226868bd219ca9246721262ea
               [0x395bed3e]=6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25
               [0x4e62e60d]=6de873656f88fa63e6f9aceed48951a42fb5703d08a643f2d250b343af178431c75dc7c4cb8454bffbec089bd92c9b25)
declare -A MN=([0x0ddbd824]=f4fb208aedddf04b29f65039f9f86008c7c65e4fd69bdb59fce6ffc3c9aa3c1d5e3ed14558f9728e0799357ab91dc11f
               [0x395bed3e]=5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e
               [0x4e62e60d]=5f2f238c88e1ae555e3aa0e5ec8d240e202089a23a7a896b8912e616efb66c5125aab1204a2e1925a5db6f888f5b5e8e)
ok=1; bad() { say "RS-6 ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }
as=$(prop ActiveState); nr=$(prop NRestarts); inv=$(prop InvocationID); inv0=$(cat "$RS/rs6-$MODE-inv0.txt" 2>/dev/null || true)
say "api-relay: $as, NRestarts $nr, invocation ${inv:0:12} (before rs-6: ${inv0:0:12})"
[ "$as" = active ] && [ "$nr" = 0 ] || bad "the api-relay is not active, or restarted"
[ -n "$inv0" ] && [ "$inv" != "$inv0" ] || bad "the api-relay was not restarted by rs-6"
end=$(( $(date +%s) + 900 )); kat=""
while [ "$(date +%s)" -lt $end ]; do
  kat=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'known-answer test at start'" || true)
  [ -n "$kat" ] && break; sleep 15
done
say "KAT: ${kat:-none after 15 min}"; [[ "$kat" == *"PASS: 2 known answer(s)"* ]] || bad "no KAT PASS"
for a in $ADM; do
  out=$(ADMIT=$a bash "$H/../accept.sh" 2>&1); echo "$out" > "$RS/rs6-$MODE-accept-${a:0:8}.txt"; echo "$out" | grep -vE '^\.\. '
  [ "$(grep -c '^ok   0x' <<<"$out")" = 3 ] && grep -qx 'ok   unknown deployment 404' <<<"$out" && grep -qx 'ok   malformed id 422' <<<"$out" \
    && [ "$(grep -c '^FAIL' <<<"$out")" = 1 ] && grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" \
    || bad "accept.sh ADMIT=${a:0:12} is not exactly 'predicted and admitted x3, release ON'"
done
for a in $REFUSED; do
  out=$(ADMIT=$a bash "$H/../accept.sh" 2>&1); echo "$out" > "$RS/rs6-$MODE-refused-${a:0:8}.txt"; echo "$out" | grep -vE '^\.\. '
  [ "$(grep -c '^FAIL 0x' <<<"$out")" = 3 ] && [ "$(grep -c '^ok   0x' <<<"$out")" = 0 ] && grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" \
    && grep -qx 'ok   unknown deployment 404' <<<"$out" && grep -qx 'ok   malformed id 422' <<<"$out" \
    && say "ok   ADMIT=${a:0:8}: REFUSED for all 3 canaries (neither predicted for release nor admitted)" || bad "accept.sh ADMIT=${a:0:12} is not refused for every canary"
done
for cid in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
  eg=$(curl -sS --max-time 60 "https://api.enclave.host/v1/expected-guest?id=$cid" || true); c10=${cid:0:10}
  python3 -c '
import json, sys
r = json.loads(sys.argv[1]); want = set(sys.argv[2].split()); adm_want = set(sys.argv[3].split()); im = r.get("images", [])
got = {i["release"] for i in im}; adm = {i["release"] for i in im if i.get("releaseAdmitted") is True}
m = {i["release"]: i.get("measurement") for i in im}
ok = got == want and adm == adm_want and (sys.argv[5] == "-" or m.get(sys.argv[4]) == sys.argv[5]) and m.get(sys.argv[7]) == sys.argv[6]
sys.exit(0 if ok else 1)' "$eg" "$SET" "$ADM" "$R7" "$([ $MODE = rollback ] && echo "${M7[$c10]}" || echo -)" "${MN[$c10]}" "$RN" 2>/dev/null \
    && say "ok   $c10: installed = $(for a in $SET; do printf '%s ' ${a:0:8}; done); admitted = $(for a in $ADM; do printf '%s ' ${a:0:8}; done); 52156652 ${MN[$c10]:0:12} (= 63's)" \
    || bad "$c10: the installed/admitted sets or measurements are not the expected ones: ${eg:0:400}"
done
for id in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
  curl -sS -m 15 "https://api.enclave.host/v1/secrets/release-status?id=$id" | grep -q '"listed":true' || bad "release-status ${id:0:10} is not listed:true"
done
curl -sS -m 15 "https://api.enclave.host/v1/secrets/release-status?id=0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77" | grep -q '"listed":false' || bad "a69dcbba is not listed:false"
peak=$(prop MemoryPeak); say "MemoryPeak $peak"; [[ "$peak" =~ ^[0-9]+$ ]] && [ "$peak" -lt $((1536*1024*1024)) ] || bad "MemoryPeak $peak"
[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.enclave.host/enclaves)" = 200 ] || bad "/enclaves is not 200"
boot=$(cat $HOME/enclave-prod/guestd-root/*/*.serial 2>/dev/null | grep -aoE 'DOM serving vsock=443 spki_sha256=[0-9a-f]{64}' | grep -oE '[0-9a-f]{64}$' | sort -u)
spki() { timeout 20 openssl s_client -connect "$1.app.enclave.host:443" -servername "$1.app.enclave.host" </dev/null 2>/dev/null \
         | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64; }
canaries_ok() { local c r; for c in 0ddbd824 395bed3e 4e62e60d; do r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' "https://$c.app.enclave.host/" 2>/dev/null)
  [ "$r" = 200/0 ] && grep -qx "$(spki $c)" <<<"$boot" || return 1; done; }
uswest_ok() { curl -sSf -m 20 https://api.enclave.host/v1/relays | python3 -c "import json,sys; d=json.load(sys.stdin); r=[x for x in d.get('relays',[]) if x.get('name')=='us-west']; sys.exit(0 if len(r)==1 and r[0].get('address')=='5.78.85.108' and d.get('labels') else 1)" 2>/dev/null; }
wait_for 180 canaries_ok && say "ok   the canaries 200 over valid TLS with their guests' boot keys" || bad "the canaries do not serve with their guests' boot keys"
wait_for 180 uswest_ok && say "ok   us-west listed at 5.78.85.108 (labels present)" || bad "us-west is not listed"
wait_for 180 relay_row_ok && say "ok   metal-iso0 serving and eligible" || bad "metal-iso0 is not serving and eligible"
[ $ok = 1 ] && say "RS-6 $MODE ACCEPTED" || { say "RS-6 $MODE NOT ACCEPTED$([ "$MODE" = apply ] && echo ': rollback = rs-6.sh rollback, then rs-6-accept.sh rollback')"; exit 1; }
