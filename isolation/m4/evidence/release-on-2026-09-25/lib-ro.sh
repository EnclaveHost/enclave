# Step 2 (4b), the relay's attested release ON for the 3 canaries (ENABLEMENT.md step 2, rev 4.1 f95e2d55): enclave-5d's
# relay-release-on.sh / relay-release-off.sh (reviewed by enclave-d1 and enclave-e3), run AS ROOT ON nan from a private
# 0700 directory, byte-checked there first. Sourced AFTER ../pool-rollout-20260925/lib.sh and ../s4c-20260925/lib4cc.sh
# (the node's 4c-c state: NEWM/NEWC, LW/LAUNCH_SHA, node_runs_from).
RO=~/enclave-bench/release-on-20260925; LOGR=$RO/release-on.log
ON_SH=$RO/relay-release-on.sh;  ON_SHA=f09f511c29ff46419f28565514489cb840398e1a5a1cbf5e92f613ca77719772
OFF_SH=$RO/relay-release-off.sh; OFF_SHA=fef9905fe93b650ecea4b34a8e78f1ce84971fc6a56d2ae6b2e67921fa972b43
CAN="0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e"
ADMIT=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$LOGR"; } 2>/dev/null || true; }
rstat_code() { curl -sS -o /dev/null -m 15 -w '%{http_code}' "https://api.enclave.host/v1/secrets/release-status?id=$1"; }
rstat_listed() { curl -sS -m 15 "https://api.enclave.host/v1/secrets/release-status?id=$1" | grep -q '"listed":true'; }
local_sha() { local s; s=$(sha256sum "$1") && echo "${s%% *}"; }
# copy $1 into a fresh 0700 dir on nan, require its sha256 there = $2, run it with sh as root UNDER ONE LOCK (enclave-d1: an
# ssh drop leaves the remote script running, so on and off must never edit the env file at once), its output into a
# file there (a dropped connection cannot EPIPE it mid-edit), then print that and remove the dir. Returns the script's
# own code (2 = REFUSED, nothing changed); 75 = the lock was not free within 600 s (nothing ran); 90-92 = the copy
# failed (nothing ran); 255 = ssh itself (the script may still be running: off waits on the lock)
NANX="ssh -i $HOME/.ssh/nan-ci-deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 nan"
nan_run() {
  local d s
  d=$($NANX 'umask 077; mktemp -d') && [[ "$d" =~ ^/tmp/tmp\.[A-Za-z0-9]+$ ]] || return 90
  $NANX "cat > $d/s.sh" < "$1" || { $NANX "rm -rf $d" || true; return 91; }
  s=$($NANX "sha256sum $d/s.sh") && [ "${s:0:64}" = "$2" ] || { $NANX "rm -rf $d" || true; return 92; }
  $NANX "flock -E 75 -w 600 /run/enclave-relay-release.lock sh $d/s.sh > $d/out 2>&1; rc=\$?; cat $d/out; rm -rf $d; exit \$rc"
}
rprop() { $NANX "systemctl show enclave-api-relay -p $1 --value"; }
node_on_4cc() { [ "$(node_attested)" = "$NEWM $NEWC" ] && node_runs_from "$LW" "$LAUNCH_SHA"; }
# e3's accept.sh (38000e62) after release ON: every line ok EXCEPT its release-OFF line, which must read EXACTLY
# "answered 403" (enclave-d1, enclave-e3: an unsigned ticket for the unlisted 0xabab... passes the rate and id checks and
# stops at the listing gate, 403 release_not_enabled: the positive proof the list is enforced). Returns 0 = that shape;
# 2 = the release line answered anything but 403 (not the reviewed path: HOLD and look, no automatic rollback);
# 1 = anything else failed
accept_after_on() {
  local out nf
  out=$(ADMIT=$ADMIT bash ~/enclave-bench/rs4-20260925/pkg/accept.sh 2>&1) || true
  echo "$out" > $RO/accept-after-on.txt
  [ "$(grep -c '^ok   0x' <<<"$out" || [ $? = 1 ])" = 3 ] && grep -qx 'ok   unknown deployment 404' <<<"$out" && grep -qx 'ok   malformed id 422' <<<"$out" || return 1
  nf=$(grep -c '^FAIL' <<<"$out" || [ $? = 1 ])
  [ "$nf" = 1 ] && grep -q '^FAIL release-ticket answered [0-9]*, expected 503$' <<<"$out" || return 1
  grep -qx 'FAIL release-ticket answered 403, expected 503' <<<"$out" || return 2
}
# the guests' identities from check_guestd's last read ($EV/.guestd.json): a relaunch changes the name, createdAt and key
guests_id() { python3 -c "import json,sys; v=json.load(open('$EV/.guestd.json'))[1]['body']['vms']; r=sorted([x['id'],x['name'],x['createdAt'],x['measurement'],x['transportKeySha256'],x['status']] for x in v); sys.exit(1) if len(r)!=3 or any(not all(a) for a in r) else print(json.dumps(r,separators=(',',':')))"; }
