#!/usr/bin/env bash
# relay-window health (enclave-87's four checks), read-only: KAT in the CURRENT api-relay invocation; the 3 canaries 200
# over valid TLS with the key their guest printed at boot (guestd serial 'DOM serving … spki_sha256'); us-west in
# /v1/relays with its address; release ON for exactly the 3 canaries (accept.sh ADMIT=79c5ecf2: only the 403 FAIL line).
set -uo pipefail
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
API=https://api.enclave.host; ok=1; bad() { echo "UNHEALTHY: $*"; ok=0; }
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); nr=$($NAN "systemctl show enclave-api-relay -p NRestarts --value")
act=$($NAN "systemctl show enclave-api-relay -p ActiveEnterTimestamp --value")
end=$(( $(date +%s) + ${KAT_WAIT:-900} )); kat=""
while [ "$(date +%s)" -lt $end ]; do
  kat=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'known-answer test at start'" || true); [ -n "$kat" ] && break; sleep 15; done
echo "api relay: invocation ${inv:0:12} since $act, NRestarts $nr; KAT: ${kat:-none}"
[[ "$kat" == *"PASS: 2 known answer(s)"* ]] || bad "no KAT PASS in the current invocation"; [ "$nr" = 0 ] || bad "NRestarts $nr"
boot=$(cat $HOME/enclave-prod/guestd-root/*/*.serial 2>/dev/null | grep -aoE 'DOM serving vsock=443 spki_sha256=[0-9a-f]{64}' | grep -oE '[0-9a-f]{64}$' | sort -u)
spki() { timeout 20 openssl s_client -connect "$1.app.enclave.host:443" -servername "$1.app.enclave.host" </dev/null 2>/dev/null \
         | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64; }
for c in 0ddbd824 395bed3e 4e62e60d; do
  r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' "https://$c.app.enclave.host/" 2>/dev/null); k=$(spki $c)
  grep -qx "$k" <<<"$boot" && kb=guest-boot-key || kb=NOT-a-guest-boot-key
  echo "canary $c: $r spki ${k:0:16} ($kb)"; [ "$r" = 200/0 ] && [ "$kb" = guest-boot-key ] || bad "canary $c"
done
curl -sSf -m 20 $API/v1/relays | python3 -c "
import json,sys; d=json.load(sys.stdin); r=[x for x in d.get('relays',[]) if x.get('name')=='us-west']
print('us-west:', [(x.get('name'),x.get('address'),x.get('address6')) for x in r], '| relays', len(d.get('relays',[])), 'labels', len(d.get('labels') or {}))
sys.exit(0 if len(r)==1 and r[0].get('address')=='5.78.85.108' and d.get('labels') else 1)" || bad "us-west is not listed with 5.78.85.108 (or no labels)"
# the release listing, DERIVED from the live env (enclave-87 item 4): every listed id answers listed:true, the 3 canaries are
# among them, and an unlisted (synthetic) id answers listed:false
LIVE_LISTED=$($NAN "grep -E '^SECRETS_RELEASE_DEPLOYMENTS=' /etc/nan-relay/api-relay.env | cut -d= -f2 | tr ',' '\n' | grep -xE '0x[0-9a-f]{64}'")
NL=$(grep -c . <<<"$LIVE_LISTED")
for c in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
  grep -qx "$c" <<<"$LIVE_LISTED" || bad "canary ${c:0:10} is not in the live listing"; done
for id in $LIVE_LISTED; do
  curl -sS -m 15 "$API/v1/secrets/release-status?id=$id" | grep -q '"listed":true' || bad "release-status ${id:0:10} not listed:true"; done
curl -sS -m 15 "$API/v1/secrets/release-status?id=0x$(printf 'e7%.0s' $(seq 32))" | grep -q '"listed":false' || bad "an unlisted id is not listed:false"
if [ "${CERT_SEPARATE:-0}" != 1 ]; then
  out=$(ADMIT=${ADMIT:-f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca} bash $HOME/Projects/enclave-release/docs/security/attested-release-integration/accept.sh 2>&1)
  [ "$(grep -c '^ok   0x' <<<"$out")" = 3 ] && [ "$(grep -c '^FAIL' <<<"$out")" = 1 ] && grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" \
    && echo "release: listed x$NL (the live listing, canaries included; an unlisted id not), accept.sh = exactly 'release ON'" || { echo "$out"; bad "accept.sh is not exactly 'release ON'"; }
else
  # SECRETS_RELEASE_CERT_RELEASES set (the KAT-only releases are no longer certifiable, by design): accept.sh's canary lines
  # (the 09-24 guests' measurements under the KAT releases) no longer apply. Instead: each canary's expected guest lists ONLY
  # the admitted release, at its pinned measurement; the release is ON (a ticket answers 403); 404 and 422 as before.
  declare -A PIN=([0x0ddbd824]=a0101960e272080545e5c0ba7b32c74bbf16849050871b33cb9d52d5749c4b2df082b14148f27bc217ae02bf09f6541a
                  [0x395bed3e]=4bfae407cddd0e7cac1a886aabdc45711ab7718053f27c1f28f64eb6c3bfd2ca239f5613f270b4ef51f897116f28e84e
                  [0x4e62e60d]=4bfae407cddd0e7cac1a886aabdc45711ab7718053f27c1f28f64eb6c3bfd2ca239f5613f270b4ef51f897116f28e84e)
  for id in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
    eg=""; end=$(( $(date +%s) + 240 ))
    while :; do eg=$(curl -sS -m 40 -w '\n%{http_code}' "$API/v1/expected-guest?id=$id"); c=${eg##*$'\n'}; eg=${eg%$'\n'*}; [ "$c" = 503 ] && [ "$(date +%s)" -lt $end ] || break; sleep 5; done
    python3 -c 'import json,sys; r=json.loads(sys.argv[1]); im=r.get("images",[]); sys.exit(0 if [(i["release"], i.get("releaseAdmitted"), i["measurement"]) for i in im] == [(sys.argv[2], True, sys.argv[3])] else 1)' "$eg" "$ADMIT" "${PIN[${id:0:10}]}" 2>/dev/null \
      || bad "expected-guest ${id:0:10} does not list ONLY ${ADMIT:0:8} (admitted) at its pin: ${eg:0:200}"
  done
  r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"0x'"$(printf 'ab%.0s' $(seq 32))"'"}' "$API/v1/secrets/release-ticket"); [ "$r" = 403 ] || bad "release-ticket answered $r, not 403 (release ON)"
  [ "$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$API/v1/expected-guest?id=0x$(printf 'cd%.0s' $(seq 32))")" = 404 ] || bad "unknown deployment not 404"
  [ "$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$API/v1/expected-guest?id=0x12")" = 422 ] || bad "malformed id not 422"
  echo "release (cert set separate): each canary's expected guest = ONLY ${ADMIT:0:8} at its pin; release ON; 404/422"
fi
[ $ok = 1 ] && echo "HEALTHY $(date -u +%H:%M:%SZ)" || { echo "NOT HEALTHY $(date -u +%H:%M:%SZ)"; exit 1; }
