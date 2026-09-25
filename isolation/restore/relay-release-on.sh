#!/bin/sh
# Turn the attested release ON on the api relay (nan), for the 3 CANARIES only (ENABLEMENT.md step 2). Run AS ROOT ON nan.
# Prepared by enclave-5d; reviewed by enclave-e3 and enclave-d1; executed by enclave-63. It prints no value of any env key.
#
# Preconditions it checks (it refuses, changing nothing, if any fails):
#   - U7 is deployed: the running api-relay.js is the converged commit's (the release needs U7's hostEligibility);
#   - the release is not already configured (none of the keys below is present), and SECRETS_RELEASE_DOMAIN_RELEASES is set
#     (rs-4: 79c5ecf2 admitted);
#   - the signing seed file is a regular file, mode 600, owned by enclave-api-relay (the relay refuses anything else).
# Then: ONE backup of api-relay.env, FIVE appended lines, ONE restart, and the checks. Rollback: relay-release-off.sh.
set -eu
ENV=/etc/nan-relay/api-relay.env
SEED=/etc/nan-relay/secrets-release-signing.seed
U7_API_RELAY=1b823be6a64324221a9a6aeedbff5b5118f234dea97b070f6b981c9a82d8d3f2   # relay/api-relay.js at 2144fcb3
CANARIES=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76,0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595,0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e
# the same firmware floor guestd (-min-tcb) and the node image (ISOLATION_MIN_TCB) already enforce
MINTCB='{"Turin":{"fmc":1,"bootloader":3,"tee":2,"snp":5,"microcode":117}}'
die() { echo "REFUSED: $*" >&2; exit 2; }

[ "$(id -u)" = 0 ] || die "run as root on nan"
[ "$(sha256sum /opt/nan-relay/api-relay.js | cut -c1-64)" = "$U7_API_RELAY" ] || die "the running api-relay.js is not U7's converged commit (deploy U7 first)"
for k in SECRETS_ATTESTED_RELEASE SECRETS_RELEASE_DEPLOYMENTS SECRETS_RELEASE_MIN_TCB SECRETS_RELEASE_VMPL SECRETS_RELEASE_SIGNING_KEY_FILE SECRETS_RELEASE_SIGNING_KEY; do
  ! grep -q "^$k=" "$ENV" || die "$k is already in $ENV (the release is already configured, or half-configured)"
done
grep -q "^SECRETS_RELEASE_DOMAIN_RELEASES=." "$ENV" || die "SECRETS_RELEASE_DOMAIN_RELEASES is not set (rs-4 first)"
[ -f "$SEED" ] && [ "$(stat -c %a "$SEED")" = 600 ] && [ "$(stat -c %U "$SEED")" = enclave-api-relay ] \
  || die "$SEED must be a regular file, mode 600, owned by enclave-api-relay"
[ "$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "https://api.enclave.host/v1/secrets/release-status?id=${CANARIES%%,*}")" = 503 ] \
  || die "release-status does not answer 503 release_off before the change"

BK="$ENV.pre-release-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV" "$BK"
echo "backup: $BK"
{ echo "SECRETS_ATTESTED_RELEASE=1"
  echo "SECRETS_RELEASE_DEPLOYMENTS=$CANARIES"
  echo "SECRETS_RELEASE_MIN_TCB='$MINTCB'"
  echo "SECRETS_RELEASE_VMPL=0"
  echo "SECRETS_RELEASE_SIGNING_KEY_FILE=$SEED"
} >> "$ENV"
T0=$(date -u '+%Y-%m-%d %H:%M:%S')
systemctl restart enclave-api-relay

# ---- checks: every refusal below says "roll back with relay-release-off.sh $BK" ----
fail() { echo "CHECK FAILED: $* - roll back: sh relay-release-off.sh $BK" >&2; exit 1; }
for _ in $(seq 1 60); do systemctl is-active --quiet enclave-api-relay && break; sleep 1; done
systemctl is-active --quiet enclave-api-relay || fail "enclave-api-relay is not active"
sleep 5
for id in $(echo "$CANARIES" | tr , ' '); do
  a=$(curl -sS -m 15 "https://api.enclave.host/v1/secrets/release-status?id=$id")
  echo "$a" | grep -q '"listed":true' || fail "release-status for ${id%${id#??????????}}… is not listed:true ($a)"
done
a=$(curl -sS -m 15 "https://api.enclave.host/v1/secrets/release-status?id=0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77")
echo "$a" | grep -q '"listed":false' || fail "a non-canary (a69dcbba) is not listed:false ($a)"
! journalctl -u enclave-api-relay --since "$T0" --no-pager -o cat | grep -q '\[secrets-release\].*refused' \
  || fail "the relay refused a release setting (see its journal: [secrets-release] … refused)"
[ "$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://api.enclave.host/enclaves)" = 200 ] || fail "/enclaves is not 200"
echo "RELEASE ON for the 3 canaries: release-status listed:true for each, false for a69dcbba; no refused setting; /enclaves 200"
