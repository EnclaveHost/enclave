#!/bin/bash
# Root runs this on warden-host. CREATE-ONLY install of the pinned challenge release + configuration + unit. Starts nothing,
# enables nothing, touches no existing service, reads no secret (the front key is placed by root beforehand, 0600 root,
# at /etc/enclave-challenge/<label>/front.key; this script only checks it exists and is not group/world readable).
#   sudo bash install.sh <stage dir> <dns.mjs sha256> <runtime bundle sha256> <challenge-host.mjs sha256>
# <stage dir>: release/{dns.mjs,network-runtime.bundle.mjs,challenge-host.mjs,dns.mjs.manifest.json},
#              config/{challenge.json (filled from challenge.json.template), front.pem, shield-app-policy.json, network-profile-base.json},
#              enclave-challenge-host.service
set -euo pipefail
STAGE=$1 DNS=$2 RT=$3 HOST=$4
[[ $DNS =~ ^[0-9a-f]{64}$ && $RT =~ ^[0-9a-f]{64}$ && $HOST =~ ^[0-9a-f]{64}$ ]] || { echo "refused: three 64-hex pins required"; exit 2; }
LABEL=${DNS:0:12}; OPT=/opt/enclave-challenge/releases/$DNS; ETC=/etc/enclave-challenge/$LABEL; UNIT=/etc/systemd/system/enclave-challenge-host.service
sha() { sha256sum "$1" | cut -c1-64; }
[ "$(sha "$STAGE/release/dns.mjs")" = "$DNS" ] && [ "$(sha "$STAGE/release/network-runtime.bundle.mjs")" = "$RT" ] && [ "$(sha "$STAGE/release/challenge-host.mjs")" = "$HOST" ] \
  || { echo "refused: the staged release is not the pinned bytes"; exit 3; }
grep -q '<' "$STAGE/config/challenge.json" && { echo "refused: challenge.json still has <placeholders>"; exit 3; }
[ -f "$ETC/front.key" ] || { echo "refused: root must place the front key at $ETC/front.key first"; exit 3; }
[ "$(stat -c %a "$ETC/front.key")" = 600 ] && [ "$(stat -c %U "$ETC/front.key")" = root ] || { echo "refused: $ETC/front.key must be 0600 root"; exit 3; }
for p in 18253 18254 18443; do ss -Hltnu "( sport = :$p )" | grep -q . && { echo "refused: port $p is in use"; exit 3; }; done
command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "refused: node >= 22 required"; exit 3; }
RECEIPT=$ETC/install-receipt.txt
put() { # create-only: an existing file must already hold the same bytes
  local src=$1 dst=$2 mode=$3
  if [ -e "$dst" ]; then [ "$(sha "$src")" = "$(sha "$dst")" ] || { echo "refused: $dst exists with other bytes"; exit 4; }
  else install -D -o root -g root -m "$mode" "$src" "$dst"; fi
  echo "$(sha "$dst")  $dst" >> "$RECEIPT.new"
}
install -d -o root -g root -m 0755 "$OPT" "$ETC"; : > "$RECEIPT.new"
for f in dns.mjs network-runtime.bundle.mjs challenge-host.mjs dns.mjs.manifest.json; do put "$STAGE/release/$f" "$OPT/$f" 0444; done
for f in challenge.json front.pem shield-app-policy.json network-profile-base.json; do put "$STAGE/config/$f" "$ETC/$f" 0444; done
sed -e "s/@LABEL@/$LABEL/g" -e "s/@DNS_SHA@/$DNS/g" "$STAGE/enclave-challenge-host.service" > "$ETC/unit.rendered"
put "$ETC/unit.rendered" "$UNIT" 0644; rm -f "$ETC/unit.rendered"
mv "$RECEIPT.new" "$RECEIPT"
node "$OPT/challenge-host.mjs" check "$ETC/challenge.json"
systemctl daemon-reload
echo "INSTALLED $LABEL (not started, not enabled). Receipt: $RECEIPT"
