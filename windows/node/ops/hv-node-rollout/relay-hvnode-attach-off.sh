#!/bin/sh
# Turn the relay's hv-node attach OFF again, LINE-WISE: remove exactly the one line relay-hvnode-attach-on.sh added
# (RELAY_HVNODE_ATTACH=1) and nothing else, then restart. Run AS ROOT ON nan: `sh relay-hvnode-attach-off.sh`.
# It refuses, changing nothing, unless exactly one such line is present. The result must be the current file minus that
# line, every other line byte-identical and in order; mode 600/root before and after; a backup of the current file.
# Afterwards an hv node's `vbs-keys` frame is refused by name (tunnel.js:409), so the NucBox row detaches at its next
# connection; nothing else changes.
set -eu
umask 077
ENV=/etc/nan-relay/api-relay.env
LINE="RELAY_HVNODE_ATTACH=1"
die() { echo "REFUSED: $*" >&2; exit 2; }
modeok() { [ "$(stat -c %a "$1")" = 600 ] && [ "$(stat -c %U "$1")" = root ]; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
modeok "$ENV" || die "$ENV must be mode 600, owned by root"
[ "$(grep -cxF -- "$LINE" "$ENV" || true)" = 1 ] || die "expected exactly one line '$LINE'"
[ "$(grep -c '^RELAY_HVNODE_ATTACH=' "$ENV" || true)" = 1 ] || die "RELAY_HVNODE_ATTACH appears with another value (decide by hand)"
D=$(mktemp -d); trap 'rm -rf "$D"; rm -f "$ENV.tmp"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
BK="$ENV.pre-hvnode-attach-off-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV" "$BK"; modeok "$BK" || die "the backup $BK is not 600/root"
echo "backup of the current file: $BK"
grep -vxF -- "$LINE" "$ENV" > "$D/new" || true
awk -v l="$LINE" '$0 != l' "$ENV" > "$D/expect"
[ "$(wc -l < "$D/new")" = $(( $(wc -l < "$ENV") - 1 )) ] && cmp -s "$D/new" "$D/expect" \
  || die "the edit would not be the current file minus exactly that line (nothing changed)"
install -m 600 -o root -g root "$D/new" "$ENV.tmp" && mv "$ENV.tmp" "$ENV"
modeok "$ENV" || die "$ENV lost its mode 600/root (put back $BK by hand)"
systemctl restart enclave-api-relay
for _ in $(seq 1 60); do systemctl is-active --quiet enclave-api-relay && break; sleep 1; done
systemctl is-active --quiet enclave-api-relay || { echo "enclave-api-relay is not active" >&2; exit 1; }
echo "HV-NODE ATTACH OFF (line-wise): every other env line unchanged; the relay is active"
