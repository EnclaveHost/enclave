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
# the release listing as of step 6 (63, 02:13-02:17Z): the 3 canaries + Steven's 3 apps listed; an id NOT listed (synthetic)
# answers listed:false (the negative control; a69dcbba served that role until step 6 listed it)
for id in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e \
          0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77 0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a 0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371; do
  curl -sS -m 15 "$API/v1/secrets/release-status?id=$id" | grep -q '"listed":true' || bad "release-status ${id:0:10} not listed:true"; done
curl -sS -m 15 "$API/v1/secrets/release-status?id=0x$(printf 'e7%.0s' $(seq 32))" | grep -q '"listed":false' || bad "an unlisted id is not listed:false"
out=$(ADMIT=${ADMIT:-52156652d67a20a71643a5158624058dfeb6b88b58d8de47b360cf0a2a2eb6a1} bash $HOME/Projects/enclave-release/docs/security/attested-release-integration/accept.sh 2>&1)
[ "$(grep -c '^ok   0x' <<<"$out")" = 3 ] && [ "$(grep -c '^FAIL' <<<"$out")" = 1 ] && grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" \
  && echo "release: listed x6 (3 canaries + Steven's 3; an unlisted id not), accept.sh = exactly 'release ON'" || { echo "$out"; bad "accept.sh is not exactly 'release ON'"; }
[ $ok = 1 ] && echo "HEALTHY $(date -u +%H:%M:%SZ)" || { echo "NOT HEALTHY $(date -u +%H:%M:%SZ)"; exit 1; }
