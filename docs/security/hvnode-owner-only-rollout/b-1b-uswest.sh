#!/usr/bin/env bash
# B step 1b: us-west MANUALLY (U7 step 4's shape; enclave-87): it carries ALL app SNI and runs relay.js + fleet.mjs, which CI
# never deploys. Needs the us-west ssh master Steven opened (ssh -O check us-west = "Master running"); held otherwise.
# Back up relay.js + fleet.mjs to *.pre-b; copy fleet.mjs FIRST, then relay.js, each to a temp name then mv; verify both
# hashes; restart enclave-tcp-relay ONLY; watch 2 min; check; any failure = instant rollback (b-rollback-uswest.sh).
set -euo pipefail; source "$(dirname "$0")/lib.sh"
ssh -O check us-west 2>&1 | grep -q "Master running" || { say "HOLD 1b: no us-west ssh master (Steven's key): steps 2 and 3 may proceed without it"; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
git -C $MAIN show $BC:relay/fleet.mjs > $W/fleet.mjs; git -C $MAIN show $BC:relay/relay.js > $W/relay.js
[ "$(sha256sum < $W/fleet.mjs | cut -c1-64)" = "${SHA[fleet.mjs]}" ] && [ "$(sha256sum < $W/relay.js | cut -c1-64)" = "${SHA[relay.js]}" ] || { say "REFUSING: local copies are not B's"; exit 2; }
# us-west must run what main ran before B (U7's e0cb218f / 384a1ef1), so this step brings B's change and nothing else
h0=$($US 'sha256sum /opt/nan-relay/relay.js /opt/nan-relay/fleet.mjs' | awk '{print substr($1,1,16)}' | tr '\n' ' ')
[ "$h0" = "e0cb218f6947911e 384a1ef1daf26e8e " ] || { say "REFUSING: us-west runs relay.js/fleet.mjs $h0, not main's pre-B pair"; exit 2; }
$US 'test ! -e /opt/nan-relay/relay.js.pre-b && test ! -e /opt/nan-relay/fleet.mjs.pre-b && systemctl is-active --quiet enclave-tcp-relay' || { say "REFUSING: a *.pre-b exists, or tcp-relay is not active"; exit 3; }
nr0=$($US 'systemctl show enclave-tcp-relay -p NRestarts --value')
say "B step 1b: us-west backup, fleet.mjs then relay.js, restart enclave-tcp-relay (live SNI sessions drop; clients reconnect)"
$US 'cp -p /opt/nan-relay/relay.js /opt/nan-relay/relay.js.pre-b && cp -p /opt/nan-relay/fleet.mjs /opt/nan-relay/fleet.mjs.pre-b'
scp -q -o BatchMode=yes $W/fleet.mjs us-west:/opt/nan-relay/fleet.mjs.b && $US 'mv /opt/nan-relay/fleet.mjs.b /opt/nan-relay/fleet.mjs'
scp -q -o BatchMode=yes $W/relay.js us-west:/opt/nan-relay/relay.js.b && $US 'mv /opt/nan-relay/relay.js.b /opt/nan-relay/relay.js'
files_are_b "$US" relay.js fleet.mjs || { say "B STEP 1b: the hashes on us-west are wrong: rolling back"; bash "$H/b-rollback-uswest.sh"; exit 4; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); $US 'systemctl restart enclave-tcp-relay'
fail() { say "B STEP 1b CHECK FAILED: $* -> rolling back us-west"; bash "$H/b-rollback-uswest.sh"; exit 5; }
t=$(( $(date +%s) + 120 )); while [ $(date +%s) -lt $t ]; do $US 'systemctl is-active --quiet enclave-tcp-relay' || fail "tcp-relay not active"; sleep 10; done
[ "$($US 'systemctl show enclave-tcp-relay -p NRestarts --value')" = "$nr0" ] || fail "tcp-relay restarted by itself (a crash loop)"
j=$($US "journalctl -u enclave-tcp-relay --since '$T0' --no-pager -o cat")
grep -q 'eligibility: https://api.enclave.host/enclaves every 15s' <<<"$j" || fail "no eligibility line"; ! grep -q 'unset: NO host is eligible' <<<"$j" || fail "UNSET feed"
nl=$($US 'ss -ltnH | wc -l'); [ "$nl" -ge 49000 ] || fail "listeners: $nl"
canaries_dns || fail "a canary is not 200 via us-west (DNS)"
# a refusal for a CANARY is a failure (they are eligible); one for another name (e.g. test 1 before step 2) is expected
! grep -qE '^\[relay\] 0x(0ddbd824|395bed3e|4e62e60d)[0-9a-f]* -> .* REFUSED' <<<"$j" || fail "tcp-relay refused a canary"
say "B STEP 1b DONE: us-west on B (relay.js ${SHA[relay.js]:0:8}, fleet.mjs ${SHA[fleet.mjs]:0:8}), tcp-relay up 2 min, no restarts, $nl listeners, canaries 200 via DNS"
