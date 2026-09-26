#!/usr/bin/env bash
# Acceptance of the hv-node attach flip (A): the relay is healthy and everything that went through it before still does.
#   hv-attach-accept.sh on|off
#   1. the api relay: a NEW invocation, NRestarts 0, the predictor's known-answer test PASS in that invocation (cold: up to
#      15 min), and no startup line about the retired METAL_VBS_* keys (on);
#   2. the attested release still ON for exactly the 3 canaries (listed:true x3, a69dcbba false), and accept.sh with ADMIT
#      = 79c5ecf2 failing ONLY its release-ticket line with 403 (every canary's expected guest 200, 404, 422);
#   3. the three SNP canaries 200 over valid public TLS with the SAME keys as before the flip (nothing relaunched), and
#      metal-iso0 re-attached, serving and eligible within 180 s;
#   4. /enclaves 200; any hv-node row is mode hv-node, NOT eligible, with the honest reason (host not excluded).
set -uo pipefail
MODE=${1:?usage: hv-attach-accept.sh on|off}; H=$(cd "$(dirname "$0")" && pwd)
OUT=${HV_OUT:-$HOME/enclave-bench/hvnode-attach-20260925}
NAN="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 nan"
API=https://api.enclave.host
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; echo "$m" >> "$OUT/flip.log"; }
ok=1; bad() { say "ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }
inv=$(prop InvocationID); nr=$(prop NRestarts); inv0=$(cat "$OUT/inv0-$MODE.txt" 2>/dev/null || true)
say "api relay: invocation ${inv:0:12} (before ${inv0:0:12}), NRestarts $nr"
[ -n "$inv0" ] && [ "$inv" != "$inv0" ] && [ "$nr" = 0 ] || bad "not a clean single restart"
end=$(( $(date +%s) + 900 )); kat=""
while [ "$(date +%s)" -lt $end ]; do
  kat=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'known-answer test at start'" || true)
  [ -n "$kat" ] && break; sleep 15
done
say "KAT: ${kat:-none after 15 min}"; [[ "$kat" == *"PASS: 2 known answer(s)"* ]] || bad "no KAT PASS"
if [ "$MODE" = on ]; then
  $NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -c 'METAL_VBS_' || true" | grep -qx 0 || bad "the relay still logs the retired METAL_VBS_* keys"
fi
for id in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
  curl -sS -m 15 "$API/v1/secrets/release-status?id=$id" | grep -q '"listed":true' || bad "release-status ${id:0:10} is not listed:true"
done
curl -sS -m 15 "$API/v1/secrets/release-status?id=0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77" | grep -q '"listed":false' || bad "a69dcbba is not listed:false"
out=$(ADMIT=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4 bash "$H/../attested-release-integration/accept.sh" 2>&1); echo "$out" > "$OUT/accept-$MODE.txt"
[ "$(grep -c '^ok   0x' <<<"$out")" = 3 ] && grep -qx 'ok   unknown deployment 404' <<<"$out" && grep -qx 'ok   malformed id 422' <<<"$out" \
  && [ "$(grep -c '^FAIL' <<<"$out")" = 1 ] && grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" || bad "accept.sh is not exactly 'release ON' (accept-$MODE.txt)"
spki() { timeout 20 openssl s_client -connect "$1.app.enclave.host:443" -servername "$1.app.enclave.host" </dev/null 2>/dev/null \
         | openssl x509 -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform der 2>/dev/null | sha256sum | cut -c1-64; }
end=$(( $(date +%s) + 180 ))
while :; do
  allok=1
  while read -r c k; do
    r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}/%{ssl_verify_result}' "https://$c.app.enclave.host/" 2>/dev/null)
    [ "$r" = "200/0" ] && [ "$(spki "$c")" = "$k" ] || allok=0
  done < "$OUT/keys-before-$MODE.txt"
  row=$(curl -sS -m 20 "$API/enclaves" | python3 -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for e in d.get('enclaves',[]) if 'metal-iso0' in json.dumps(e) and e.get('serving') and e.get('eligible')))" 2>/dev/null || echo 0)
  [ $allok = 1 ] && [ "$row" = 1 ] && break
  [ "$(date +%s)" -ge $end ] && { bad "after 180 s: canaries same-key 200 = $allok, metal-iso0 serving+eligible = $row"; break; }
  sleep 10
done
say "canaries 200 with the same keys; metal-iso0 serving and eligible: $([ $allok = 1 ] && [ "$row" = 1 ] && echo yes || echo NO)"
curl -sS -m 20 "$API/enclaves" > "$OUT/enclaves-$MODE.json" || bad "/enclaves unreadable"
curl -sS -m 20 "$API/v1/relays" > "$OUT/relays-after-$MODE.json" || bad "/v1/relays unreadable"
curl -sS -m 20 "$API/availability" > "$OUT/availability-after-$MODE.json" || bad "/availability unreadable"
# enclave-bf: what the relay publishes from rows' own words must not change: the SAME relays (name, address, address6,
# services) and every label that named a relay before still names the same one (a new deployment may add labels); the
# SAME public volumes. And an hv-node row, if one is attached, is host-attach-only; zero rows is said, not passed silently.
python3 - "$OUT" "$MODE" <<'PY' || bad "the relay roster, the volumes aggregate or an hv-node row changed"
import json, sys
o, m = sys.argv[1], sys.argv[2]
ld = lambda n: json.load(open(f"{o}/{n}-{m}.json"))
key = lambda r: (r.get("name"), r.get("address"), r.get("address6"), json.dumps(r.get("services"), sort_keys=True))
rb, ra = ld("relays-before"), ld("relays-after")
assert sorted(map(key, rb["relays"])) == sorted(map(key, ra["relays"])), ("relays changed", rb["relays"], ra["relays"])
lb, la = rb.get("labels") or {}, ra.get("labels") or {}
moved = [k for k, v in lb.items() if (la.get(k) or {}).get("relay") != (v or {}).get("relay")]
assert not moved, ("labels moved relay", moved[:10])
vb, va = ld("availability-before")["volumes"], ld("availability-after")["volumes"]
assert json.dumps(vb, sort_keys=True) == json.dumps(va, sort_keys=True), ("volumes changed", vb, va)
rows = [e for e in ld("enclaves")["enclaves"] if str(e.get("mode", "")).lower() == "hv-node"]
for e in rows:
    assert e.get("eligible") is not True and e.get("serving") is not True and e.get("attach") == "attestation", e
print(f"relays unchanged ({len(ra['relays'])}); labels kept ({len(lb)} before, {len(la)} after); volumes unchanged ({len(va)})")
print(f"hv-node rows: {len(rows)}" + (" (each NOT eligible, NOT serving, attach attestation)" if rows else " - NOT EXERCISED: no NucBox node is attached (the attach itself is proven by the relay's own tests)"))
PY
[ $ok = 1 ] && say "HV-ATTACH $MODE ACCEPTED" || { say "HV-ATTACH $MODE NOT ACCEPTED$([ "$MODE" = on ] && echo ': rollback = hv-attach.sh off, then hv-attach-accept.sh off')"; exit 1; }
