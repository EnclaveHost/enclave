# Step 3, ON nan as root (cs-3-env.sh feeds it to bash -s): SECRETS_RELEASE_CERT_RELEASES appended (on) or removed (off), then
# ONE api-relay restart (env-line-remote.sh's reviewed shape). The VALUE is never typed: it is READ here from the env file's
# own DOMAIN_RELEASES line, which must be exactly one 64-hex release, installed (in PREDICT_RELEASES), and equal to EXPECT
# (f7888d86, the only admitted release after rs-8): a certificate set without the admitted release is a predictor PROBLEM that
# refuses every prediction (5d). The relay must run the code that reads the key (PINS: the pushed files). TRUSTED_OPERATORS and
# every release setting stay byte-identical. If the relay does not stay up 30 s, the pre-edit copy goes back AT ONCE.
set -euo pipefail
# predictor consistency of an env FILE, as makePredictor judges it (enclave-5d's M1): every admitted release installed; with a
# certificate set, every named one installed AND every admitted one in it. A file that fails would give the predictor a
# PROBLEM that refuses EVERY prediction (the secrets release included) - so it is never written. Prints the problem, or nothing.
consistent() { python3 - "$1" <<'PYC'
import sys, re
kv = {}
for l in open(sys.argv[1]):
    m = re.match(r"^(SECRETS_RELEASE_(?:PREDICT_RELEASES|DOMAIN_RELEASES|CERT_RELEASES))=(.*)$", l.rstrip("\n"))
    if m: kv.setdefault(m.group(1), []).append(m.group(2))
if any(len(v) > 1 for v in kv.values()): print("a release key appears more than once"); sys.exit()
one = lambda k: kv.get(k, [""])[0]
inst = {p.split("=", 1)[0].strip().lower() for p in one("SECRETS_RELEASE_PREDICT_RELEASES").split(",") if "=" in p}
adm = {x.strip().lower() for x in one("SECRETS_RELEASE_DOMAIN_RELEASES").split(",") if x.strip()}
cert = {x.strip().lower() for x in one("SECRETS_RELEASE_CERT_RELEASES").split(",") if x.strip()}
short = lambda s: ",".join(sorted(x[:12] for x in s))
if not adm: print("no admitted release")
elif adm - inst: print("admitted but not installed: " + short(adm - inst))
elif cert and cert - inst: print("a certificate release is not installed: " + short(cert - inst))
elif cert and adm - cert: print("SECRETS_RELEASE_CERT_RELEASES leaves out the admitted " + short(adm - cert) + ": run cs-3-env.sh off FIRST")
PYC
}
: "${MODE:?}" "${EXPECT:?}" "${STAMP:?}" "${PINS:?}"
umask 077
ENV=/etc/nan-relay/api-relay.env; R=/opt/nan-relay; KEY=SECRETS_RELEASE_CERT_RELEASES
die() { echo "REFUSING: $*"; exit 2; }
modeok() { [ "$(stat -c '%a %U' "$1")" = "600 root" ]; }
tdig() { grep -E '^TRUSTED_OPERATORS=' "$1" | sha256sum | cut -c1-16; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
modeok "$ENV" || die "$ENV is not 0600 root"
[ -z "$(tail -c1 "$ENV")" ] || die "$ENV does not end with a newline"
[ "$(grep -cE '^[a-z.-]+\.m?js [0-9a-f]{64}$' <<<"$PINS")" = 3 ] && [ "$(grep -c . <<<"$PINS")" = 3 ] || die "PINS is not the 3 pushed relay files"
while read -r f h; do [ -n "$f" ] || continue; [ "$(sha256sum < "$R/$f" | cut -c1-64)" = "$h" ] || die "$R/$f is not the pushed (reviewed) file"; done <<<"$PINS"
systemctl is-active --quiet enclave-api-relay || die "enclave-api-relay is not active"
T0=$(tdig "$ENV")
echo "$EXPECT" | grep -qxE '[0-9a-f]{64}' || die "EXPECT is not one 64-hex release id"
if [ "$MODE" = on ]; then
  # the value, from the admitted set itself: exactly one release, installed, the expected one (after rs-8)
  [ "$(grep -c '^SECRETS_RELEASE_DOMAIN_RELEASES=' "$ENV")" = 1 ] || die "not exactly one DOMAIN_RELEASES line"
  VALUE=$(grep '^SECRETS_RELEASE_DOMAIN_RELEASES=' "$ENV" | cut -d= -f2- | tr -d ' ')
  [ "$VALUE" = "$EXPECT" ] || die "the admitted set is not exactly ${EXPECT:0:12} (not after rs-8?)"
  grep '^SECRETS_RELEASE_PREDICT_RELEASES=' "$ENV" | grep -q "[=,]$VALUE=" || die "the admitted release is not installed"
else VALUE=$EXPECT; fi                     # off removes exactly the line on added, whatever else changed since
LINE="$KEY=$VALUE"
relset() { grep -E '^SECRETS_(ATTESTED_RELEASE|RELEASE_DEPLOYMENTS|RELEASE_SIGNING_KEY_FILE|RELEASE_MIN_TCB|RELEASE_VMPL|RELEASE_PREDICT_RELEASES|RELEASE_DOMAIN_RELEASES)=' "$1" | sha256sum | cut -c1-64; }
R0=$(relset "$ENV")
case $MODE in
  on)  [ "$(grep -c "^$KEY=" "$ENV" || true)" = 0 ] || die "$KEY is already set (a hand edit: decide by hand)" ;;
  off) [ "$(grep -cx "$LINE" "$ENV" || true)" = 1 ] && [ "$(grep -c "^$KEY=" "$ENV" || true)" = 1 ] || die "not exactly one '$KEY=<the reviewed value>' line" ;;
  *) die "MODE is on or off" ;;
esac
inv0=$(systemctl show enclave-api-relay -p InvocationID --value)
D=$(mktemp -d); trap 'rm -rf "$D"; rm -f "$ENV.cs3-new"' EXIT
BAK="$ENV.bak-cs3-$MODE-$STAMP"; cp -p "$ENV" "$BAK"; modeok "$BAK" || die "the backup is not 0600 root"
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
[ "$(tdig "$D/new")" = "$T0" ] && [ "$(relset "$D/new")" = "$R0" ] || die "the TRUSTED_OPERATORS or a release setting line would change (nothing changed)"
why=$(consistent "$D/new"); [ -z "$why" ] || die "the new env would refuse EVERY prediction: $why (nothing written)"
install -m 600 -o root -g root "$D/new" "$ENV.cs3-new" && mv "$ENV.cs3-new" "$ENV"
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
echo "nan: $KEY $MODE applied (= the admitted ${VALUE:0:12}); api relay invocation ${inv0:0:12} -> $inv1, NRestarts 0, stayed up 30 s; TRUSTED_OPERATORS digest after $(tdig "$ENV")"
