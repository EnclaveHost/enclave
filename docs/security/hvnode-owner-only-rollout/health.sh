#!/usr/bin/env bash
# relay-window health (enclave-87's four checks), read-only: KAT in the CURRENT api-relay invocation; the 3 canaries 200
# over valid TLS with the key their guest printed at boot (guestd serial 'DOM serving … spki_sha256'); us-west in
# /v1/relays with its address; release ON for exactly the 3 canaries (accept.sh ADMIT=79c5ecf2: only the 403 FAIL line).
set -uo pipefail
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
API=https://api.enclave.host; ok=1; bad() { echo "UNHEALTHY: $*"; ok=0; }
# the admitted release both modes check (set ONCE here: the cert-set branch read an unset ADMIT, which aborted step 3's first
# acceptance at 04:45:33Z and rolled a healthy line back)
ADMIT=${ADMIT:-f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca}
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
# after an api-relay restart the tunnels re-attach (metal-iso0 in ~60-90 s; enclave-63). WAIT - bounded (HEALTH_SETTLE_SEC,
# default 180 s) - for a signal INDEPENDENT of the checks (enclave-bf): the CURRENT invocation's journal shows both
# "[tunnel] us-west attached" and "[tunnel] metal-iso0 attached", i.e. both came back after this restart. Then judge ONCE:
# the checks below are never retried. Not back at the bound = judged as it is.
attached_since_restart() { [ "$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -oE '^\[tunnel\] (us-west|metal-iso0) attached' | sort -u | wc -l")" -ge 2 ]; }
t0=$(date +%s); until attached_since_restart || [ $(( $(date +%s) - t0 )) -ge ${HEALTH_SETTLE_SEC:-180} ]; do sleep 10; done
echo "settle: us-west + metal-iso0 re-attached in this invocation after $(( $(date +%s) - t0 )) s of waiting$(attached_since_restart || echo ' (NOT both at the bound: judged as is)')"
curl -sS -m 20 "$API/enclaves" | python3 -c "import json,sys; r=[e for e in json.load(sys.stdin).get('enclaves',[]) if e.get('name')=='metal-iso0']; sys.exit(0 if r and r[0].get('serving') and r[0].get('eligible') else 1)" 2>/dev/null || bad "metal-iso0 is not serving and eligible"
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
  out=$(ADMIT=$ADMIT bash $HOME/Projects/enclave-release/docs/security/attested-release-integration/accept.sh 2>&1)
  [ "$(grep -c '^ok   0x' <<<"$out")" = 3 ] && [ "$(grep -c '^FAIL' <<<"$out")" = 1 ] && grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" \
    && echo "release: listed x$NL (the live listing, canaries included; an unlisted id not), accept.sh = exactly 'release ON'" || { echo "$out"; bad "accept.sh is not exactly 'release ON'"; }
else
  # SECRETS_RELEASE_CERT_RELEASES set (the KAT-only releases are no longer certifiable, by design): accept.sh's canary lines
  # (the 09-24 guests' measurements under the KAT releases) no longer apply. Instead: each canary's expected guest lists ONLY
  # the admitted release, at its pinned measurement; the release is ON (a ticket answers 403); 404 and 422 as before.
  # the pins per (release, canary): f7888d86 and 5db18199 (enclave-63's and enclave-bf's independent values = the relay's);
  # ADMIT may name several releases (rs-9: "f7888d86 5db18199"): the expected guest must be EXACTLY one admitted image per
  # named release, at its pin, and nothing else (no KAT-only or retired release)
  declare -A PIN=([f7888d86:0x0ddbd824]=a0101960e272080545e5c0ba7b32c74bbf16849050871b33cb9d52d5749c4b2df082b14148f27bc217ae02bf09f6541a
                  [f7888d86:0x395bed3e]=4bfae407cddd0e7cac1a886aabdc45711ab7718053f27c1f28f64eb6c3bfd2ca239f5613f270b4ef51f897116f28e84e
                  [f7888d86:0x4e62e60d]=4bfae407cddd0e7cac1a886aabdc45711ab7718053f27c1f28f64eb6c3bfd2ca239f5613f270b4ef51f897116f28e84e
                  [5db18199:0x0ddbd824]=6716ef1462e1ebabc4fd388c44dea5da1fe6902a60bedbc47aaaeae5199ee91003c8c842c34dde264b31d10c68d5871b
                  [5db18199:0x395bed3e]=be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b
                  [5db18199:0x4e62e60d]=be2bb73c799fa8315d23101521da7f2bf944d7964a56793ce713266426af47237758961ee2b9c2ca22683e43aac13f2b
                  # aee2059f (R, rs-11): enclave-63's and enclave-bf's independent values (expected-measurement.sh --pin, 4cd26e58)
                  [aee2059f:0x0ddbd824]=3facefd88284eac612f9b4e71ee35fc7b200d74f352c4d8d20e8b35e4a9599a456b88716d3d4f0bf579ee156c0cb57f4
                  [aee2059f:0x395bed3e]=8a291bbf99818bdb6339ee34020d194d1de385c9f4597db60525c8cef0cc0318943e41d4d6d5ee4c3a98c4972b279504
                  [aee2059f:0x4e62e60d]=8a291bbf99818bdb6339ee34020d194d1de385c9f4597db60525c8cef0cc0318943e41d4d6d5ee4c3a98c4972b279504)
  for id in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
    want=""; for rel in $ADMIT; do p=${PIN[${rel:0:8}:${id:0:10}]:-}; [ -n "$p" ] || { bad "no pin for ${rel:0:8} x ${id:0:10}"; continue; }; want="$want $rel:$p"; done
    eg=""; end=$(( $(date +%s) + 240 ))
    while :; do eg=$(curl -sS -m 40 -w '\n%{http_code}' "$API/v1/expected-guest?id=$id"); c=${eg##*$'\n'}; eg=${eg%$'\n'*}; [ "$c" = 503 ] && [ "$(date +%s)" -lt $end ] || break; sleep 5; done
    python3 -c 'import json,sys; r=json.loads(sys.argv[1]); got=sorted((i["release"], i.get("releaseAdmitted"), i["measurement"]) for i in r.get("images",[])); want=sorted((w.split(":")[0], True, w.split(":")[1]) for w in sys.argv[2].split()); sys.exit(0 if got == want else 1)' "$eg" "$want" 2>/dev/null \
      || bad "expected-guest ${id:0:10} is not exactly [$(for rel in $ADMIT; do printf '%s ' ${rel:0:8}; done)] admitted at their pins: ${eg:0:200}"
  done
  r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"0x'"$(printf 'ab%.0s' $(seq 32))"'"}' "$API/v1/secrets/release-ticket"); [ "$r" = 403 ] || bad "release-ticket answered $r, not 403 (release ON)"
  [ "$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$API/v1/expected-guest?id=0x$(printf 'cd%.0s' $(seq 32))")" = 404 ] || bad "unknown deployment not 404"
  [ "$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$API/v1/expected-guest?id=0x12")" = 422 ] || bad "malformed id not 422"
  [ $ok = 1 ] && echo "release (cert set separate): each canary's expected guest = EXACTLY [$(for rel in $ADMIT; do printf '%s ' ${rel:0:8}; done)] admitted at their pins; release ON; 404/422"
fi
[ $ok = 1 ] && echo "HEALTHY $(date -u +%H:%M:%SZ)" || { echo "NOT HEALTHY $(date -u +%H:%M:%SZ)"; exit 1; }
