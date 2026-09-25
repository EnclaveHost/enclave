#!/bin/sh
# Turn the attested release OFF again on the api relay (nan): restore the env file relay-release-on.sh backed up, and
# restart. Run AS ROOT ON nan: `sh relay-release-off.sh /etc/nan-relay/api-relay.env.pre-release-<stamp>`.
# Afterwards EVERY release and ticket request is refused (503 release_off), which is fail-closed:
#   - the supervisor reads release_off as "unlisted" (releaseListedFor), so a canary RELAUNCHED from now on comes back on
#     the LEGACY image (it has no config or secrets), and a deployment WITH config or staged secrets is refused at launch
#     and stays queued (isolationSpawnRelease);
#   - a running release guest keeps the config it already holds until it is relaunched;
#   - a release guest caught STARTING (waiting for its ticket) at the switch-off gets none, and its front powers the
#     domain off after its wait; the supervisor's next launch of it is legacy, per the first point.
set -eu
ENV=/etc/nan-relay/api-relay.env
BK=${1:?usage: relay-release-off.sh <backup made by relay-release-on.sh>}
[ "$(id -u)" = 0 ] || { echo "run as root on nan" >&2; exit 2; }
case "$BK" in "$ENV".pre-release-*) ;; *) echo "not a backup relay-release-on.sh made: $BK" >&2; exit 2 ;; esac
[ -f "$BK" ] || { echo "no such backup: $BK" >&2; exit 2; }
cp -p "$ENV" "$ENV.rolled-back-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$BK" "$ENV"
systemctl restart enclave-api-relay
for _ in $(seq 1 60); do systemctl is-active --quiet enclave-api-relay && break; sleep 1; done
sleep 5
c=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "https://api.enclave.host/v1/secrets/release-status?id=0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76")
[ "$c" = 503 ] && echo "RELEASE OFF: release-status 503 (release_off) again" || { echo "release-status answered $c, not 503" >&2; exit 1; }
