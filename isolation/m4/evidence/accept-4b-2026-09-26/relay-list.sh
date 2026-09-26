#!/bin/sh
# Add or remove ONE deployment id on the api relay's attested-release list (SECRETS_RELEASE_DEPLOYMENTS): ENABLEMENT.md
# step 4b (the acceptance deployment) and step 6 (an app of Steven's). Run AS ROOT ON nan, under the release lock (the
# caller: flock /run/enclave-relay-release.lock). Prepared by enclave-63. It prints no value of any env key but that list
# (deployment ids, public on chain).
#   sh relay-list.sh add|remove 0x<64 hex>
# Refuses, changing nothing, unless: root; the env is mode 600 root with a final newline; the release is ON; there is
# exactly ONE list line and it is a comma list of ids that holds the 3 canaries; the id is (add) not / (remove) is on it;
# never removes a canary (step 2's rollback does that). Then ONE backup, the ONE line replaced (verified: every other line
# byte-identical, in order), an atomic rename in /etc/nan-relay, ONE restart, checks; a failed check restores the backup
# and restarts again (exit 1).
set -eu
umask 077
ENV=/etc/nan-relay/api-relay.env; DIR=/etc/nan-relay; API=https://api.enclave.host
CANARIES="0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"
A69=0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77
ACT=${1:-}; ID=${2:-}
die() { echo "REFUSED: $*" >&2; exit 2; }
modeok() { [ "$(stat -c %a "$1")" = 600 ] && [ "$(stat -c %U "$1")" = root ]; }
listed() { curl -sS -m 15 "$API/v1/secrets/release-status?id=$1" | grep -q "\"listed\":$2"; }
[ "$(id -u)" = 0 ] || die "run as root on nan"
case "$ACT" in add|remove) ;; *) die "usage: relay-list.sh add|remove 0x<64 hex>";; esac
printf '%s\n' "$ID" | grep -qxE '0x[0-9a-f]{64}' || die "the id must be 0x + 64 lowercase hex"
modeok "$ENV" || die "$ENV must be mode 600, owned by root"
[ -z "$(tail -c1 "$ENV")" ] || die "$ENV does not end in a newline"
grep -qx 'SECRETS_ATTESTED_RELEASE=1' "$ENV" || die "the attested release is not ON (step 2)"
[ "$(grep -c '^SECRETS_RELEASE_DEPLOYMENTS=' "$ENV" || true)" = 1 ] || die "not exactly one SECRETS_RELEASE_DEPLOYMENTS line (decide by hand)"
OLD=$(grep '^SECRETS_RELEASE_DEPLOYMENTS=' "$ENV" | cut -d= -f2-)
printf '%s\n' "$OLD" | grep -qxE '0x[0-9a-f]{64}(,0x[0-9a-f]{64})*' || die "the list is not a comma list of ids (a hand edit: decide by hand)"
for c in $CANARIES; do case ",$OLD," in *",$c,"*) ;; *) die "canary $(echo $c | cut -c1-10) is not on the list";; esac; done
case "$ACT" in
  add) case ",$OLD," in *",$ID,"*) die "$ID is already listed";; esac; NEW="$OLD,$ID";;
  remove) for c in $CANARIES; do [ "$c" != "$ID" ] || die "never unlist a canary here (step 2's rollback turns the release off)"; done
          case ",$OLD," in *",$ID,"*) ;; *) die "$ID is not listed";; esac
          NEW=$(printf '%s\n' "$OLD" | tr , '\n' | grep -vxF "$ID" | paste -sd, -);;
esac
echo "list: $(printf '%s' "$OLD" | tr , '\n' | grep -c .) id(s) -> $(printf '%s' "$NEW" | tr , '\n' | grep -c .) ($ACT $(echo $ID | cut -c1-10)...)"
BK="$ENV.pre-list-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV" "$BK"; modeok "$BK" || die "the backup $BK is not mode 600/root"
echo "backup: $BK"
T=$(mktemp "$DIR/.api-relay.env.XXXXXX")
trap 'rm -f "$T"' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
awk -v new="SECRETS_RELEASE_DEPLOYMENTS=$NEW" '/^SECRETS_RELEASE_DEPLOYMENTS=/ { print new; next } { print }' "$ENV" > "$T"
# exactly that one line differs, in place; every other line byte-identical and in order
[ "$(wc -l < "$T")" = "$(wc -l < "$ENV")" ] || die "the edit changed the line count (nothing changed)"
[ "$(grep -vn '^SECRETS_RELEASE_DEPLOYMENTS=' "$T" | sha256sum)" = "$(grep -vn '^SECRETS_RELEASE_DEPLOYMENTS=' "$ENV" | sha256sum)" ] || die "another line would change (nothing changed)"
[ "$(grep '^SECRETS_RELEASE_DEPLOYMENTS=' "$T")" = "SECRETS_RELEASE_DEPLOYMENTS=$NEW" ] || die "the new list line is not what was computed (nothing changed)"
[ "$(grep -n '^SECRETS_RELEASE_DEPLOYMENTS=' "$T" | cut -d: -f1)" = "$(grep -n '^SECRETS_RELEASE_DEPLOYMENTS=' "$ENV" | cut -d: -f1)" ] || die "the list line moved (nothing changed)"
modeok "$T" || die "the new file is not 600/root (nothing changed)"
mv -f "$T" "$ENV"; modeok "$ENV" || die "$ENV lost its mode 600/root after the rename (put back $BK by hand)"
T0=$(date -u '+%Y-%m-%d %H:%M:%S')
restart_ok() { systemctl restart enclave-api-relay; for _ in $(seq 1 60); do systemctl is-active --quiet enclave-api-relay && return 0; sleep 1; done; return 1; }
back() { echo "CHECK FAILED: $* - restoring $BK" >&2; cp -p "$BK" "$ENV.restore" && mv -f "$ENV.restore" "$ENV" && restart_ok && echo "RESTORED the list as it was ($BK) and restarted" >&2 || echo "RESTORE FAILED: put back $BK by hand" >&2; exit 1; }
restart_ok || back "enclave-api-relay is not active after the restart"
# a NEW invocation that stays up (enclave-e3): it must be unchanged, with NRestarts 0, at the end of the checks
INV=$(systemctl show -p InvocationID --value enclave-api-relay)
sleep 5
for c in $CANARIES; do listed "$c" true || back "canary $(echo $c | cut -c1-10) is not listed:true"; done
if [ "$ACT" = add ]; then listed "$ID" true || back "$(echo $ID | cut -c1-10) is not listed:true"; else listed "$ID" false || back "$(echo $ID | cut -c1-10) is not listed:false"; fi
case ",$NEW," in *",$A69,"*) ;; *) listed "$A69" false || back "a69dcbba (not on the list) is not listed:false";; esac
! journalctl -u enclave-api-relay --since "$T0" --no-pager -o cat | grep -qE '\[secrets-release\].*(refused|unreadable)' || back "the relay refused or could not read a release setting"
[ "$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$API/enclaves")" = 200 ] || back "/enclaves is not 200"
[ -n "$INV" ] && [ "$(systemctl show -p InvocationID --value enclave-api-relay)" = "$INV" ] && [ "$(systemctl show -p NRestarts --value enclave-api-relay)" = 0 ] \
  || back "the api relay restarted during the checks (a crash loop?)"
echo "LISTED ($ACT $(echo $ID | cut -c1-10)...): release-status as expected for it and the 3 canaries; no refused setting; /enclaves 200"
