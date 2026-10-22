#!/usr/bin/env bash
# Deployment-preparation checks (no host touched, nothing applied): on each LIVE literal-IP Caddyfile (the read-only copies
# in work/app-zone-certificates/live-baseline, hashes in live.sha256) apply the app-zone transform, then this Shield
# session transform; validate with the exact deployed Caddy v2.11.4 binary; check idempotence, the refusal without the
# app-zone route, and that the drop-in's profile digest is the reviewed profile's. Run via the shared queue (256 MiB).
set -euo pipefail
cd "$(dirname "$0")"
AZ=../../app-zone-certificates; CADDY=../../directory-https-activation/test/bin/caddy-2.11.4; TREE=../tree
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT; rc=0
declare -A IP=([us-west]=134.199.235.187 [eu-central]=134.209.248.172 [ap-southeast]=165.245.191.129 [ca-east]=146.190.246.39)
(cd $AZ/live-baseline && sha256sum -c --quiet live.sha256) || { echo "FAIL live baseline hashes"; exit 1; }
for h in us-west eu-central ap-southeast ca-east; do
  if ! python3 $AZ/deploy/caddy-appzone.py $AZ/live-baseline/$h.Caddyfile ${IP[$h]} $T/$h.az > /dev/null; then echo "FAIL app-zone transform $h"; rc=1; continue; fi
  if ! python3 caddy-appzone-shield.py $T/$h.az ${IP[$h]} $T/$h.Caddyfile > $T/$h.hash; then echo "FAIL shield transform $h"; rc=1; continue; fi
  if python3 caddy-appzone-shield.py $T/$h.Caddyfile ${IP[$h]} $T/$h.again > /dev/null && cmp -s $T/$h.Caddyfile $T/$h.again; then :; else echo "FAIL idempotence $h"; rc=1; fi
  if python3 caddy-appzone-shield.py $AZ/live-baseline/$h.Caddyfile ${IP[$h]} $T/$h.bare > /dev/null 2>&1; then echo "FAIL $h: applied without the app-zone route"; rc=1; fi
  if XDG_DATA_HOME=$T/d XDG_CONFIG_HOME=$T/c HOME=$T $CADDY validate --config $T/$h.Caddyfile --adapter caddyfile > $T/$h.v 2>&1; then
    echo "VALID $h app-zone+shield $(cat $T/$h.hash)"
  else echo "INVALID $h"; tail -3 $T/$h.v; rc=1; fi
  added=$(diff $T/$h.az $T/$h.Caddyfile | awk '/^>/{n++} END{print n+0}'); removed=$(diff $T/$h.az $T/$h.Caddyfile | awk '/^</{n++} END{print n+0}')
  echo "  $h: +$added lines, removed $removed (relative to the app-zone transform output)"
  [ "$removed" = 0 ] || { echo "FAIL $h removed lines"; rc=1; }
done
want=$(sed -n 's/^Environment=APP_CHALLENGE_SHIELD_PROFILE_DIGEST=//p' route-dns-appzone-shield.dropin.template)
got=$(cd $TREE && node --input-type=module -e 'import fs from "node:fs"; import {profileDigest} from "./network/authority-profile.mjs"; console.log(profileDigest(fs.readFileSync("contracts/deployments/network-profile-base.json")))')
if [ "$want" = "$got" ]; then echo "drop-in profile digest = the reviewed profile's ($got)"; else echo "FAIL drop-in digest $want != $got"; rc=1; fi
echo "[deploy] exit=$rc"; exit $rc
