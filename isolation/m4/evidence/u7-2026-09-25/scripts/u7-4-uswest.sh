#!/usr/bin/env bash
# U7 step 4 (7.4): us-west MANUALLY over the admin access (the `us-west` alias, Steven's unlocked key; not CI, not deploy.sh,
# not deploy-us-west-egress.sh). Back up relay.js + fleet.mjs to *.pre-u7; copy exactly fleet.mjs FIRST, then relay.js, from
# the converged commit, each to a temp name then mv; verify both hashes; restart enclave-tcp-relay ONLY; check.
set -euo pipefail; source ~/enclave-bench/u7-20260925/lib.sh
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
git -C $MAIN show $U7C:relay/fleet.mjs > $W/fleet.mjs; git -C $MAIN show $U7C:relay/relay.js > $W/relay.js
[ "$(sha256sum < $W/fleet.mjs | cut -c1-64)" = "$FLEET_SHA" ] && [ "$(sha256sum < $W/relay.js | cut -c1-64)" = "$RELAY_SHA" ] || { say "REFUSING: the local copies are not the expected hashes"; exit 2; }
probe "$US" > $U7/probe-uswest-before.txt 2>&1; cat $U7/probe-uswest-before.txt
$US 'test ! -e /opt/nan-relay/relay.js.pre-u7 && test ! -e /opt/nan-relay/fleet.mjs.pre-u7 && systemctl is-active --quiet enclave-tcp-relay' || { say "REFUSING: a *.pre-u7 exists, or tcp-relay is not active"; exit 3; }
nr0=$($US 'systemctl show enclave-tcp-relay -p NRestarts --value')
say "U7 step 4: us-west backup, fleet.mjs then relay.js, restart enclave-tcp-relay (live SNI sessions on the DNS path drop; clients reconnect)"
$US 'cp -p /opt/nan-relay/relay.js /opt/nan-relay/relay.js.pre-u7 && cp -p /opt/nan-relay/fleet.mjs /opt/nan-relay/fleet.mjs.pre-u7'
scp -q -o BatchMode=yes $W/fleet.mjs us-west:/opt/nan-relay/fleet.mjs.u7 && $US 'mv /opt/nan-relay/fleet.mjs.u7 /opt/nan-relay/fleet.mjs'
scp -q -o BatchMode=yes $W/relay.js us-west:/opt/nan-relay/relay.js.u7 && $US 'mv /opt/nan-relay/relay.js.u7 /opt/nan-relay/relay.js'
h=$($US 'sha256sum /opt/nan-relay/relay.js /opt/nan-relay/fleet.mjs' | awk '{print $1}' | tr '\n' ' ')
[ "$h" = "$RELAY_SHA $FLEET_SHA " ] || { say "U7 STEP 4: the hashes on us-west are wrong ($h): rolling back"; $U7/u7-rollback-uswest.sh; exit 4; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); $US 'systemctl restart enclave-tcp-relay'
fail() { say "U7 STEP 4 CHECK FAILED: $* -> rolling back us-west"; $U7/u7-rollback-uswest.sh; exit 5; }
t=$(( $(date +%s) + 120 )); while [ $(date +%s) -lt $t ]; do $US 'systemctl is-active --quiet enclave-tcp-relay' || fail "tcp-relay not active"; sleep 10; done
[ "$($US 'systemctl show enclave-tcp-relay -p NRestarts --value')" = "$nr0" ] || fail "tcp-relay restarted by itself (a crash loop)"
j=$($US "journalctl -u enclave-tcp-relay --since '$T0' --no-pager -o cat")
grep -q 'eligibility: https://api.enclave.host/enclaves every 15s' <<<"$j" || fail "no eligibility line"; ! grep -q 'unset: NO host is eligible' <<<"$j" || fail "UNSET feed"
nl=$($US 'ss -ltnH | wc -l'); [ "$nl" -ge 49000 ] && $US 'ss -ltnH "( sport = :443 or sport = :80 )" | wc -l' | grep -qE '^[2-9]' || fail "listeners: $nl (443/80?)"
canary200 dns || fail "a canary is not 200 via us-west (DNS)"
! grep -q "REFUSED: not an eligible host (U7)" <<<"$j" || fail "tcp-relay logged a U7 eligibility refusal (any line: the canaries are the only leases)"
probe "$US" > $U7/probe-uswest-after.txt 2>&1
say "U7 STEP 4 DONE: us-west on U7 (relay.js e0cb218f, fleet.mjs 384a1ef1), tcp-relay up 2 min without restarts, eligibility line, $nl listeners, canaries 200 via DNS"
