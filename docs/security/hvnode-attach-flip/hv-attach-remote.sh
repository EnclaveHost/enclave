# hv-node attach flip (A), ON nan as root (hv-attach.sh feeds it to bash -s). ATTACH-ONLY: the NucBox node on the custom
# type-1 path may attach (tunnel mode hv-node: a host-attested boot state, never a TEE, never eligible, never tenant
# capacity), and with main's U7 gates NOTHING is routed to it, certified for it or released to it (enclave-87's (A)).
#   MODE=on   append RELAY_HVNODE_ATTACH=1 and drop the retired METAL_VBS_* lines (ignored since 09-25), in ONE edit
#   MODE=off  remove the RELAY_HVNODE_ATTACH=1 line (the retired keys are not put back: nothing reads them)
# Line-wise: every other line stays byte-identical and in order; the file stays 0600 root. ONE api-relay restart. If the
# relay does not come back and STAY up (the EK bundle is read at startup when the switch is on: a missing or unreadable
# bundle would crash-loop it), the pre-edit copy is put back AT ONCE and the relay restarted again. Prints no env value.
set -euo pipefail
: "${MODE:?}" "${STAMP:?}"
umask 077
ENV=/etc/nan-relay/api-relay.env; R=/opt/nan-relay
KEY=RELAY_HVNODE_ATTACH; LINE="$KEY=1"
# the deployed relay files this flip was reviewed against (main b7a3364c)
PINS="api-relay.js 1b823be6a64324221a9a6aeedbff5b5118f234dea97b070f6b981c9a82d8d3f2
tunnel.js 1a6d71c5d90e615279c96928cb00dcfda5a40a5baa30b34bc7adab4c7f1a388f
hvnode-verify.mjs 1e5481cc7c4770c2b7fbf2d18d675d9f837e86f25d6b06e581bcf5fb9478dc68
vbs-policy.mjs 0e915d95b6771db87e00cee5ef97b82459da0b43653629a2e03264c78a3901cc
fixtures/tpm-roots.pem f72ea29aefa0d778856e105f725d3c9c66a45cfc8cb35c170782bceee8d8ba5b"
die() { echo "REFUSING: $*"; exit 2; }
modeok() { [ "$(stat -c '%a %U' "$1")" = "600 root" ]; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
modeok "$ENV" || die "$ENV is not 0600 root"
[ -z "$(tail -c1 "$ENV")" ] || die "$ENV does not end with a newline"
while read -r f h; do [ "$(sha256sum < "$R/$f" | cut -c1-64)" = "$h" ] || die "$R/$f is not the reviewed file (main b7a3364c)"; done <<<"$PINS"
[ "$(grep -c "^RELAY_HVNODE_EK_ROOTS=" "$ENV" || true)" = 0 ] || die "RELAY_HVNODE_EK_ROOTS is set (tests and labs only)"
systemctl is-active --quiet enclave-api-relay || die "enclave-api-relay is not active"
RPID=$(systemctl show -p MainPID --value enclave-api-relay); RUID=$(ps -o uid= -p "$RPID" | tr -d ' '); RGID=$(ps -o gid= -p "$RPID" | tr -d ' ')
[ -n "$RUID" ] || die "cannot read the running relay's uid"
case $MODE in
  on)
    [ "$(grep -c "^$KEY=" "$ENV" || true)" = 0 ] || die "$KEY is already set"
    # the EK bundle the relay reads at startup when the switch is on: present, parseable, readable AS the relay's uid
    setpriv --reuid "$RUID" --regid "$RGID" --clear-groups test -r "$R/fixtures/tpm-roots.pem" || die "the EK bundle is not readable as the relay's uid $RUID"
    n=$(node -e 'const fs=require("fs"),{X509Certificate}=require("crypto");const t=fs.readFileSync(process.argv[1],"utf8");const b=t.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[];for(const p of b)new X509Certificate(p);console.log(b.length)' "$R/fixtures/tpm-roots.pem") || die "the EK bundle does not parse"
    [ "$n" -ge 1 ] || die "the EK bundle holds no certificate"
    ;;
  off) [ "$(grep -cx "$LINE" "$ENV" || true)" = 1 ] && [ "$(grep -c "^$KEY=" "$ENV" || true)" = 1 ] || die "not exactly one '$LINE' line (a hand edit: decide by hand)" ;;
  *) die "MODE is on or off" ;;
esac
inv0=$(systemctl show enclave-api-relay -p InvocationID --value)
D=$(mktemp -d); trap 'rm -rf "$D"; rm -f "$ENV.hv-new"' EXIT
BAK="$ENV.bak-hvattach-$MODE-$STAMP"; cp -p "$ENV" "$BAK"; modeok "$BAK" || die "the backup is not 0600 root"
if [ "$MODE" = on ]; then
  grep -v '^METAL_VBS_[A-Z_]*=' "$ENV" > "$D/new" || true; echo "$LINE" >> "$D/new"
  dropped=$(grep -c '^METAL_VBS_[A-Z_]*=' "$ENV" || true)
  # expected independently: the old file without the retired lines, plus exactly the one new line at the end
  awk '!/^METAL_VBS_[A-Z_]*=/' "$ENV" > "$D/expect"; printf '%s\n' "$LINE" >> "$D/expect"
  [ "$(wc -l < "$D/new")" = $(( $(wc -l < "$ENV") - dropped + 1 )) ] || die "the edit is not the old file minus $dropped retired line(s) plus one"
else
  grep -vx "$LINE" "$ENV" > "$D/new" || true; dropped=0
  awk -v l="$LINE" '$0 != l' "$ENV" > "$D/expect"
  [ "$(wc -l < "$D/new")" = $(( $(wc -l < "$ENV") - 1 )) ] || die "the edit is not the old file minus the one line"
fi
cmp -s "$D/new" "$D/expect" || die "the two independent edits disagree (nothing changed)"
install -m 600 -o root -g root "$D/new" "$ENV.hv-new" && mv "$ENV.hv-new" "$ENV"
modeok "$ENV" || { cp -p "$BAK" "$ENV"; die "the new file lost 0600 root (the backup is back; nothing restarted)"; }
echo "nan: $MODE: backup $BAK; retired METAL_VBS_* lines dropped: $dropped; restarting the api relay"
systemctl restart enclave-api-relay
# the relay must come back AND stay up (a startup crash on the EK bundle loops within seconds): 30 s of watching
ok=1
for i in $(seq 1 30); do sleep 1; systemctl is-active --quiet enclave-api-relay || { ok=0; break; }; done
inv1=$(systemctl show enclave-api-relay -p InvocationID --value); nr=$(systemctl show enclave-api-relay -p NRestarts --value)
{ [ "$ok" = 1 ] && [ "$inv1" != "$inv0" ] && [ "$nr" = 0 ]; } || ok=0
if [ "$ok" != 1 ]; then
  echo "CHECK FAILED: the api relay did not stay up (active=$(systemctl is-active enclave-api-relay), NRestarts $nr): INSTANT ROLLBACK to $BAK"
  cp -p "$BAK" "$ENV"; systemctl restart enclave-api-relay; sleep 10
  systemctl is-active --quiet enclave-api-relay && echo "rolled back: the api relay is up on the pre-flip env" || echo "ROLLBACK DID NOT BRING THE RELAY UP: ESCALATE (backup $BAK)"
  exit 20
fi
echo "nan: $MODE applied; api relay invocation ${inv0:0:12} -> $inv1, NRestarts 0, stayed up 30 s; $KEY $( [ "$MODE" = on ] && echo ON || echo OFF )"
