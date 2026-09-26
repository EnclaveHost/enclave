#!/bin/sh
# Turn the relay's hv-node attach ON (RELAY_HVNODE_ATTACH, relay/api-relay.js:181) on the api relay. Run AS ROOT ON nan:
#   sh relay-hvnode-attach-on.sh <sha256 of the api-relay.js that carries enclave-e3's owner-only rule (B)>
# Approved by enclave-87 (Steven's authority) for the NucBox custom-path node. The switch alone admits an ATTACH (the
# node's windows-hv-node/v1 evidence, EK-rooted); what an attached row may SERVE is e3's owner-only rule (B), which
# must be deployed FIRST: the served owners are {operator} ∪ {owners of valid delegations}. So this script refuses
# unless the running api-relay.js is B's.
# Preconditions it checks, changing nothing if any fails:
#   - api-relay.js is B's (the argument); hvnode-verify.mjs and fixtures/tpm-roots.pem are deployed;
#   - the env is mode 600, owned by root, ends in a newline, and has no RELAY_HVNODE_ATTACH / RELAY_HVNODE_EK_ROOTS line
#     (the default EK roots are the deployed fixtures; the override is for labs only).
# Then: ONE backup, ONE appended line (verified: exactly +1, every old line byte-identical, mode unchanged), ONE restart.
# Rollback: relay-hvnode-attach-off.sh (line-wise).
set -eu
umask 077
[ $# -eq 1 ] || { echo "usage: sh relay-hvnode-attach-on.sh <api-relay.js sha256 (B)>" >&2; exit 2; }
EXPECT=$1
ENV=/etc/nan-relay/api-relay.env
RELAY=/opt/nan-relay
LINE="RELAY_HVNODE_ATTACH=1"
die() { echo "REFUSED: $*" >&2; exit 2; }
modeok() { [ "$(stat -c %a "$1")" = 600 ] && [ "$(stat -c %U "$1")" = root ]; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
[ "$(sha256sum "$RELAY/api-relay.js" | cut -c1-64)" = "$EXPECT" ] || die "the running api-relay.js is not the owner-only build (B) named"
[ -f "$RELAY/hvnode-verify.mjs" ] && [ -f "$RELAY/fixtures/tpm-roots.pem" ] || die "hvnode-verify.mjs / fixtures/tpm-roots.pem are not deployed"
modeok "$ENV" || die "$ENV must be mode 600, owned by root"
[ -z "$(tail -c1 "$ENV")" ] || die "$ENV does not end in a newline"
! grep -q '^RELAY_HVNODE_ATTACH=\|^RELAY_HVNODE_EK_ROOTS=' "$ENV" || die "an hv-node attach line is already present (decide by hand)"
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
BK="$ENV.pre-hvnode-attach-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV" "$BK"; modeok "$BK" || die "the backup $BK is not 600/root"
echo "backup: $BK"
OLDN=$(wc -l < "$ENV")
printf '%s\n' "$LINE" > "$D/add"
cat "$D/add" >> "$ENV"
if [ "$(wc -l < "$ENV")" != $((OLDN + 1)) ] || ! head -n "$OLDN" "$ENV" | cmp -s - "$BK" || ! tail -n 1 "$ENV" | cmp -s - "$D/add" || ! modeok "$ENV"; then
  cp -p "$BK" "$ENV"; die "the append did not produce exactly the old file plus one line (restored $BK; nothing restarted)"
fi
T0=$(date -u '+%Y-%m-%d %H:%M:%S')
systemctl restart enclave-api-relay
fail() { echo "CHECK FAILED: $* - roll back: sh relay-hvnode-attach-off.sh" >&2; exit 1; }
for _ in $(seq 1 60); do systemctl is-active --quiet enclave-api-relay && break; sleep 1; done
systemctl is-active --quiet enclave-api-relay || fail "enclave-api-relay is not active"
sleep 5
[ "$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://api.enclave.host/enclaves)" = 200 ] || fail "/enclaves is not 200"
! journalctl -u enclave-api-relay --since "$T0" --no-pager -o cat | grep -qi 'hvnode.*\(error\|refus\|invalid\|cannot\)' \
  || fail "the relay logged an hv-node error at start (see its journal)"
echo "HV-NODE ATTACH ON: relay active, /enclaves 200, no hv-node error at start. The node's attach is verified when it connects."
