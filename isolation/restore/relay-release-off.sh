#!/bin/sh
# Turn the attested release OFF again on the api relay (nan), LINE-WISE: remove exactly the five lines relay-release-on.sh
# added, and nothing else, then restart. Run AS ROOT ON nan: `sh relay-release-off.sh`.
#
# Line-wise, never a whole-file restore (enclave-d1): between release-ON and a rollback, the same env gains other
# lines - the 4c-c node image's entry in METAL_ALLOWED_MEASUREMENTS, a later rs-5 - and restoring an old copy would
# silently drop them (a dropped allowlist entry refuses the node). Step 6's app listings are edits to the
# SECRETS_RELEASE_DEPLOYMENTS line itself, which goes: release OFF unlists every app, by design.
#   - It removes the four FIXED lines exactly as relay-release-on.sh wrote them, and the one SECRETS_RELEASE_DEPLOYMENTS
#     line by its key (step 6 edits it).
#   - It refuses, changing nothing, if a fixed line is missing or doubled, if one of those keys has another value (a
#     hand edit: decide by hand), or if there is not exactly one SECRETS_RELEASE_DEPLOYMENTS line.
#   - The result must be the current file minus exactly those five lines, every other line byte-identical and in order;
#     the file stays mode 600, owned by root, before and after. A backup of the current file is kept.
# Afterwards EVERY release and ticket request is refused (503 release_off), which is fail-closed:
#   - the supervisor reads release_off as "unlisted" (releaseListedFor), so a canary RELAUNCHED from now on comes back on
#     the LEGACY image (it has no config or secrets), and a deployment WITH config or staged secrets is refused at launch
#     and stays queued (isolationSpawnRelease);
#   - a running release guest keeps the config it already holds until it is relaunched;
#   - a release guest caught STARTING (waiting for its ticket) at the switch-off gets none, and its front powers the
#     domain off after its wait; the supervisor's next launch of it is legacy, per the first point.
set -eu
ENV=/etc/nan-relay/api-relay.env
SEED=/etc/nan-relay/secrets-release-signing.seed
MINTCB='{"Turin":{"fmc":1,"bootloader":3,"tee":2,"snp":5,"microcode":117}}'
die() { echo "REFUSED: $*" >&2; exit 2; }
modeok() { [ "$(stat -c %a "$1")" = 600 ] && [ "$(stat -c %U "$1")" = root ]; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
modeok "$ENV" || die "$ENV must be mode 600, owned by root"

F=$(mktemp); trap 'rm -f "$F" "$F.expect" "$F.new" "$F.pre" "$F.now"' EXIT
printf '%s\n' "SECRETS_ATTESTED_RELEASE=1" "SECRETS_RELEASE_MIN_TCB='$MINTCB'" "SECRETS_RELEASE_VMPL=0" \
  "SECRETS_RELEASE_SIGNING_KEY_FILE=$SEED" > "$F"
while IFS= read -r line; do
  n=$(grep -cxF -- "$line" "$ENV" || true)
  [ "$n" = 1 ] || die "expected exactly one line '${line%%=*}=…' as relay-release-on.sh wrote it, found $n"
done < "$F"
for k in SECRETS_ATTESTED_RELEASE SECRETS_RELEASE_MIN_TCB SECRETS_RELEASE_VMPL SECRETS_RELEASE_SIGNING_KEY_FILE; do
  [ "$(grep -c "^$k=" "$ENV" || true)" = 1 ] || die "$k appears more than once (a hand edit: decide by hand)"
done
[ "$(grep -c '^SECRETS_RELEASE_DEPLOYMENTS=' "$ENV" || true)" = 1 ] || die "not exactly one SECRETS_RELEASE_DEPLOYMENTS line"

BK="$ENV.pre-release-off-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV" "$BK"
echo "backup of the current file: $BK"
# the expected result, computed independently of the edit below: every line but the five, in order
awk -v f="$F" 'BEGIN { while ((getline l < f) > 0) drop[l] = 1 } !($0 in drop) && $0 !~ /^SECRETS_RELEASE_DEPLOYMENTS=/' "$ENV" > "$F.expect"
grep -vxF -f "$F" "$ENV" | grep -v '^SECRETS_RELEASE_DEPLOYMENTS=' > "$F.new" || true
[ "$(wc -l < "$F.new")" = $(( $(wc -l < "$ENV") - 5 )) ] && cmp -s "$F.new" "$F.expect" \
  || die "the edit would not be the current file minus exactly the five lines (nothing changed)"
# what ELSE changed since release-ON, by key NAME only (enclave-e3): kept, and reported, never reverted
PRE=$(ls -1 "$ENV".pre-release-2* 2>/dev/null | tail -1 || true)
if [ -n "$PRE" ]; then
  grep '^[A-Za-z_][A-Za-z0-9_]*=' "$PRE" | sort > "$F.pre"; grep '^[A-Za-z_][A-Za-z0-9_]*=' "$F.new" | sort > "$F.now"
  other=$(diff "$F.pre" "$F.now" | sed -n 's/^[<>] \([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort -u | tr '\n' ' ')
  echo "keys changed since release-ON (kept, not reverted): ${other:-none}"
fi
install -m 600 -o root -g root "$F.new" "$ENV.tmp" && mv "$ENV.tmp" "$ENV"
modeok "$ENV" || die "$ENV lost its mode 600/root (put back $BK by hand)"
systemctl restart enclave-api-relay
for _ in $(seq 1 60); do systemctl is-active --quiet enclave-api-relay && break; sleep 1; done
sleep 5
c=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "https://api.enclave.host/v1/secrets/release-status?id=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76")
[ "$c" = 503 ] && echo "RELEASE OFF (line-wise): release-status 503 (release_off) again; every other env line unchanged" \
  || { echo "release-status answered $c, not 503" >&2; exit 1; }
