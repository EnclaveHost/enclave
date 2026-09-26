#!/usr/bin/env bash
# Step 6: list ONE of Steven's apps for the attested release (relay-list.sh add, e3-approved 3afbae85, as root on nan
# under the release lock), then enclave-63's health: the new api-relay invocation's predictor KAT PASS, the 3 canaries
# 200 over valid public TLS on their CURRENT keys (e5's state: 52156652 guests), release-status listed:true for the 3
# canaries AND every id listed so far, metal-iso0 serving/eligible. enclave-87's ruling (09-26): all 3 are listed after
# rs-6 and BEFORE Steven's S5, a recorded deviation from ENABLEMENT's "after that app's S5" (listing launches nothing: the
# claim gate refuses the app until its setConfig adds isolation.require; S6 is Steven's, after S5).
#   s6-list.sh a69dcbba|d9798e4c|a77d0c57
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh; source ~/enclave-bench/accept-4b-20260926/lib-4b.sh
D=~/enclave-bench/s6-20260926; LOG6=$D/s6.log
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOG6"; } 2>/dev/null || true; }
case ${1:-} in
  a69dcbba) ID=0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77;;
  d9798e4c) ID=0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a;;
  a77d0c57) ID=0xa77d0c577c1ca48510ff72545f9e050dc7d1fc9c6d1129f056494a5190cb8371;;
  *) echo "usage: s6-list.sh a69dcbba|d9798e4c|a77d0c57"; exit 2;;
esac
[ "$(sha256sum < "$RL" | cut -c1-64)" = "$RL_SHA" ] || { say "REFUSING: relay-list.sh is not the reviewed 3afbae85"; exit 2; }
for a in 0ddbd824 395bed3e 4e62e60d; do [ -f $ST/accepted-$a ] || { say "REFUSING: canary $a is not accepted on 52156652 (e5)"; exit 2; }; done
# the relay must no longer admit 79c5ecf2 (rs-6, e3): Steven's apps must never launch on the leaky release
for c in $CAN; do curl -sS -m 20 "https://api.enclave.host/v1/expected-guest?id=$c" | python3 -c "import json,sys; r=json.load(sys.stdin); a={i.get('release') for i in r.get('images',[]) if i.get('releaseAdmitted') is True}; sys.exit(0 if a=={'$REL'} else 1)" \
  || { say "REFUSING: the relay does not admit EXACTLY 52156652 for ${c:0:10} (rs-6 first)"; exit 3; }; done
check_guestd4 >/dev/null && public_ok4 && relay_row_ok || { say "REFUSING: the canaries or metal-iso0 are not healthy now"; exit 3; }
INV0=$(rprop InvocationID) && [[ "$INV0" =~ ^[0-9a-f]{32}$ ]] || { say "REFUSING: the api relay's InvocationID is unreadable"; exit 3; }
say "step 6: listing ${ID:0:10} (relay-list.sh add; one api-relay restart)"
set +e; nan_list add "$ID" > $D/list-$1.txt 2>&1; rc=$?; set -e
say "step 6: relay-list.sh add ${ID:0:10} exited $rc: $(tr '\n' ' ' < $D/list-$1.txt | cut -c1-240)"
[ $rc = 0 ] || { say "STOP: the listing failed (rc $rc; relay-list.sh restores its backup on a failed check)"; exit 4; }
INV1=$(rprop InvocationID) && [ "$INV1" != "$INV0" ] || { say "STOP: no new api-relay invocation"; exit 5; }
end=$(( $(date +%s) + 900 )); kat=""
while [ $(date +%s) -lt $end ]; do kat=$($NANX "journalctl _SYSTEMD_INVOCATION_ID=$INV1 --no-pager -o cat | grep -m1 'known-answer test at start'" || true); [ -n "$kat" ] && break; sleep 15; done
[[ "$kat" == *"PASS: 2 known answer(s)"* ]] || { say "STOP: no predictor KAT PASS in the new relay process (${kat:-none after 15 min})"; exit 5; }
wait_for 180 relay_row_ok || { say "STOP: metal-iso0 did not re-attach serving/eligible"; exit 5; }
wait_for 300 public_ok4 || { say "STOP: the canaries do not serve on their current keys"; exit 5; }
for c in $CAN $(grep -h '^LISTED ' $LOG6 2>/dev/null | awk '{print $2}') $ID; do rstat_listed $c || { say "STOP: ${c:0:10} is not listed:true"; exit 5; }; done
[ "$(rprop InvocationID)" = "$INV1" ] && [ "$(rprop NRestarts)" = 0 ] || { say "STOP: the api relay restarted during the checks"; exit 5; }
echo "LISTED $ID $(date -u +%FT%TZ)" >> $LOG6
say "step 6: ${ID:0:10} LISTED and checked (KAT PASS, metal-iso0 serving, canaries 200 on their keys, every listed id listed:true)"
