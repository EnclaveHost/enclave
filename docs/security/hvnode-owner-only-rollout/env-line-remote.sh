# B steps 2 and 3, ON nan as root (b-2-hvops.sh / b-3-reverify.sh feed it to bash -s): ONE line of the api relay's env,
# appended (on) or removed (off), then ONE api-relay restart. Modeled on hv-attach-remote.sh (reviewed).
#   KEY=RELAY_HVNODE_OPERATORS  VALUE=0x389c3f030a209d04d026228d2d053feb75dbadca   (step 2: owner-only serving for nucbox-k11)
#   KEY=RELAY_REVERIFY          VALUE=enforce                                      (step 3: dialed rows need re-verification)
# No other key or value is accepted. Line-wise: every other line stays byte-identical and in order; the file stays 0600
# root; the TRUSTED_OPERATORS line is recorded as a digest before and after and must be unchanged (enclave-87). The relay
# files must be B's (PINS). If the relay does not come back and STAY up 30 s, the pre-edit copy is put back AT ONCE.
set -euo pipefail
: "${MODE:?}" "${KEY:?}" "${VALUE:?}" "${STAMP:?}" "${PINS:?}"
umask 077
ENV=/etc/nan-relay/api-relay.env; R=/opt/nan-relay; LINE="$KEY=$VALUE"
die() { echo "REFUSING: $*"; exit 2; }
case "$KEY=$VALUE" in
  RELAY_HVNODE_OPERATORS=0x389c3f030a209d04d026228d2d053feb75dbadca|RELAY_REVERIFY=enforce) ;;
  *) die "not one of the two reviewed lines" ;;
esac
modeok() { [ "$(stat -c '%a %U' "$1")" = "600 root" ]; }
tdig() { grep -E '^TRUSTED_OPERATORS=' "$1" | sha256sum | cut -c1-16; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
modeok "$ENV" || die "$ENV is not 0600 root"
[ -z "$(tail -c1 "$ENV")" ] || die "$ENV does not end with a newline"
[ "$(grep -cE '^[a-z.-]+\.m?js [0-9a-f]{64}$' <<<"$PINS")" = 6 ] && [ "$(grep -c . <<<"$PINS")" = 6 ] || die "PINS is not the 6 relay files (enclave-bf)"
while read -r f h; do [ -n "$f" ] || continue; [ "$(sha256sum < "$R/$f" | cut -c1-64)" = "$h" ] || die "$R/$f is not B's reviewed file"; done <<<"$PINS"
systemctl is-active --quiet enclave-api-relay || die "enclave-api-relay is not active"
T0=$(tdig "$ENV")
case $MODE in
  on)  [ "$(grep -c "^$KEY=" "$ENV" || true)" = 0 ] || die "$KEY is already set (a hand edit: decide by hand)" ;;
  off) [ "$(grep -cx "$LINE" "$ENV" || true)" = 1 ] && [ "$(grep -c "^$KEY=" "$ENV" || true)" = 1 ] || die "not exactly one '$KEY=<the reviewed value>' line" ;;
  *) die "MODE is on or off" ;;
esac
inv0=$(systemctl show enclave-api-relay -p InvocationID --value)
D=$(mktemp -d); trap 'rm -rf "$D"; rm -f "$ENV.b-new"' EXIT
BAK="$ENV.bak-b-$KEY-$MODE-$STAMP"; cp -p "$ENV" "$BAK"; modeok "$BAK" || die "the backup is not 0600 root"
if [ "$MODE" = on ]; then
  cp "$ENV" "$D/new"; echo "$LINE" >> "$D/new"
  awk '1' "$ENV" > "$D/expect"; printf '%s\n' "$LINE" >> "$D/expect"
  [ "$(wc -l < "$D/new")" = $(( $(wc -l < "$ENV") + 1 )) ] || die "the edit is not the old file plus one line"
else
  grep -vx "$LINE" "$ENV" > "$D/new" || true
  awk -v l="$LINE" '$0 != l' "$ENV" > "$D/expect"
  [ "$(wc -l < "$D/new")" = $(( $(wc -l < "$ENV") - 1 )) ] || die "the edit is not the old file minus the one line"
fi
cmp -s "$D/new" "$D/expect" || die "the two independent edits disagree (nothing changed)"
[ "$(tdig "$D/new")" = "$T0" ] || die "the TRUSTED_OPERATORS line would change (nothing changed)"
install -m 600 -o root -g root "$D/new" "$ENV.b-new" && mv "$ENV.b-new" "$ENV"
modeok "$ENV" || { cp -p "$BAK" "$ENV"; die "the new file lost 0600 root (the backup is back; nothing restarted)"; }
echo "nan: $KEY $MODE: backup $BAK; TRUSTED_OPERATORS line digest $T0 (unchanged); restarting the api relay"
systemctl restart enclave-api-relay
ok=1
for i in $(seq 1 30); do sleep 1; systemctl is-active --quiet enclave-api-relay || { ok=0; break; }; done
inv1=$(systemctl show enclave-api-relay -p InvocationID --value); nr=$(systemctl show enclave-api-relay -p NRestarts --value)
{ [ "$ok" = 1 ] && [ "$inv1" != "$inv0" ] && [ "$nr" = 0 ]; } || ok=0
if [ "$ok" != 1 ]; then
  echo "CHECK FAILED: the api relay did not stay up (active=$(systemctl is-active enclave-api-relay), NRestarts $nr): INSTANT ROLLBACK to $BAK"
  cp -p "$BAK" "$ENV"; systemctl restart enclave-api-relay; sleep 10
  systemctl is-active --quiet enclave-api-relay && echo "rolled back: the api relay is up on the pre-edit env" || echo "ROLLBACK DID NOT BRING THE RELAY UP: ESCALATE (backup $BAK)"
  exit 20
fi
echo "nan: $KEY $MODE applied; api relay invocation ${inv0:0:12} -> $inv1, NRestarts 0, stayed up 30 s; TRUSTED_OPERATORS digest after $(tdig "$ENV")"
