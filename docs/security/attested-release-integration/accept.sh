#!/usr/bin/env bash
# Post-activation acceptance, READ-ONLY, run from any host with curl + node (no key needed). Exits non-zero on any miss.
#   accept.sh [API base, default https://api.enclave.host]
#   ADMIT=<release id> accept.sh ...   also requires, for every canary, an image under that release with releaseAdmitted
#                                      true (the relay predicts AND admits it: the tree switch's precondition)
# 1. each live canary's expected guest (the relay's PREDICTION) contains the canary's own chip-attested measurement and
#    AppID, as a (measurement, runtimeId) pair; 2. the release is still OFF (a ticket request answers 503
#    release_unconfigured); 3. an unknown deployment is 404, a malformed id 422.
set -u
API=${1:-https://api.enclave.host}
fail=0
# the canaries: deployment id, AppID and measurement from their chip-signed reports (docs/security/measurement-prediction/evidence)
while read -r id app meas; do
  # a fresh relay predicts COLD (the endpoint waits at most 3 s, then 503 warming + retryAfterSec): retry a 503 for up to
  # 4 minutes, honouring retryAfterSec; any other answer is final
  body=""; end=$(( $(date +%s) + 240 ))
  while :; do
    body=$(curl -sS --max-time 40 -w '\n%{http_code}' "$API/v1/expected-guest?id=$id") || body=$'\n000'
    code=${body##*$'\n'}; body=${body%$'\n'*}
    [ "$code" = 503 ] && [ "$(date +%s)" -lt "$end" ] || break
    after=$(node -e 'try { const a = JSON.parse(process.argv[1]).retryAfterSec; process.stdout.write(String(Number.isInteger(a) && a > 0 && a <= 60 ? a : 5)); } catch { process.stdout.write("5"); }' "$body")
    echo "..   ${id:0:10}: 503 (warming), retry in ${after}s" >&2; sleep "$after"
  done
  node -e '
    const [b, app, meas] = process.argv.slice(1); let r; try { r = JSON.parse(b); } catch { r = {}; }
    const hit = r.appId === app && (r.images || []).find((i) => i.measurement === meas && i.runtimeId === "ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8");
    const adm = process.env.ADMIT, ai = adm && (r.images || []).find((i) => i.release === adm && i.releaseAdmitted === true);
    const ok = hit && (!adm || ai);
    console.log((ok ? "ok   " : "FAIL ") + `${process.argv[4].slice(0, 10)}: ` + (ok ? `measurement ${meas.slice(0, 12)} predicted under release ${hit.release.slice(0, 12)}` +
      (adm ? `; release ${adm.slice(0, 12)} predicted (${ai.measurement.slice(0, 12)}) and admitted` : "") : b.slice(0, 300)));
    process.exit(ok ? 0 : 1);' "$body" "$app" "$meas" "$id" || fail=1
done <<'CANARIES'
0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 d2c4dfc0ec475910aa509d1045ae4f2997346c1cd666a167cd5fc959c036aa24 be6b8644384eee12396881e3e4cbca4259ae1a16a1e198d2c48d577ff7b3c6d355971eccebe8353749439adca718da4d
0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45 c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e
0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e 9c3d10f1450e17bc6a21478723193ef7e3da409afe353e264714cb801d180d45 c068f423578cda6316fd9462db6b5e9047bd34d6e2c0ae3b0819828e8db78831bd76bdb27092efefe380713662815f9e
CANARIES
r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"0x'"$(printf 'ab%.0s' $(seq 32))"'"}' "$API/v1/secrets/release-ticket")
[ "$r" = 503 ] && echo "ok   the release is OFF (release-ticket 503)" || { echo "FAIL release-ticket answered $r, expected 503"; fail=1; }
r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$API/v1/expected-guest?id=0x$(printf 'cd%.0s' $(seq 32))"); [ "$r" = 404 ] && echo "ok   unknown deployment 404" || { echo "FAIL unknown deployment $r"; fail=1; }
r=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$API/v1/expected-guest?id=0x12"); [ "$r" = 422 ] && echo "ok   malformed id 422" || { echo "FAIL malformed id $r"; fail=1; }
exit $fail
