#!/usr/bin/env bash
# The FIXED-release relaunch for ONE canary (0ddbd824, then 395bed3e, then 4e62e60d), after the S5 tree switch: its
# preconditions (guestd on iso-4cdd5169; the canary its 79c5ecf2 release guest; the relay predicting AND admitting
# 52156652 for it), a snapshot (incl. the new prediction and, for hookbin, the leak CONTROL: its 79c5ecf2 serial holds
# "Unsolicited response"), the OWNER's restart through the node base (api.enclave.host/v1/auth is full-service only;
# enclave-d1), then e5-proofs.sh DETACHED. The key ONLY from this process's environment as ENCLAVE_KEY. Run e.g.
#   bash -ic 'ENCLAVE_KEY="$ETH_AGENT_WALLET" ~/enclave-bench/e5-20260926/e5-restart.sh 0ddbd824'
# Derived from e4-restart.sh. Nothing here rolls back: a failed proof HOLDs (e5-proofs.sh).
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh
ID=${1:?0ddbd824, 395bed3e or 4e62e60d}; canary "$ID" || { echo "unknown canary $ID"; exit 2; }
[[ "${ENCLAVE_KEY:-}" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || { say "REFUSING: ENCLAVE_KEY (the agent wallet, 64 hex) is not in this process's environment"; exit 2; }
# one canary at a time, in order, each only once
[ -z "$PREV" ] || [ -f $ST/accepted-$PREV ] || { say "REFUSING: $PREV is not accepted yet (order: 0ddbd824, 395bed3e, 4e62e60d)"; exit 2; }
[ ! -e $ST/$ID-before.json ] && [ ! -e $ST/accepted-$ID ] || { say "REFUSING: 4e already ran for $ID ($ST/$ID-before.json)"; exit 2; }
systemctl --user list-units --plain --no-legend --all 'e4-*' 'e5-*' 'rr-*-apply-*' 's4c*-apply-*' 's5t-apply-*' | grep -q . && { say "REFUSING: a rollout unit is active"; exit 2; }
X=$(systemctl --user show enclave-guestd.service -p ExecStart --value) && grep -Fq -- " -isolation $NEWT/isolation " <<<"$X" || { say "REFUSING: guestd's -isolation is not $NEWT (run the S5 tree switch first)"; exit 2; }
# the state 4e starts from
node_on_4cc || { say "REFUSING: the node is not 02f6e313 / f6cbd75a on launcher 578be084"; exit 3; }
relay_row_ok || { say "REFUSING: the relay does not list metal-iso0 serving and eligible"; exit 3; }
for id in $CAN; do rstat_listed $id || { say "REFUSING: release-status for ${id:0:10} is not listed:true (step 2)"; exit 3; }; done
check_guestd4 || { say "REFUSING: guestd is not the 3 canaries with 4e's expected keys"; exit 3; }
noncanary_empty || { say "REFUSING: a non-canary deployment is (or may be) on metal-iso0"; exit 3; }
wait_for 60 public_ok4 || { say "REFUSING: the canaries do not serve with 4e's expected keys"; exit 3; }
[[ "$RELM" =~ ^[0-9a-f]{96}$ ]] && [ "$RELM" != "$LEGM" ] || { say "REFUSING: no pinned 52156652 measurement for $ID"; exit 3; }
M=$(expected_rel $FULL) && [ "$M" = "$RELM" ] || { say "REFUSING: the relay's 52156652 prediction for $ID is '${M:-none}', not the independently computed ${RELM:0:12}"; exit 3; }
vms4 > $ST/$ID-vms-before.json || { say "REFUSING: guestd unreadable"; exit 3; }
E=$(entry4 $FULL) || { say "REFUSING: no single guestd entry for $ID"; exit 3; }
python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e['status']=='running' and e['measurement']=='$LEGM' and e.get('release') is True else 1)" "$E" \
  || { say "REFUSING: $ID is not its running 79c5ecf2 RELEASE guest (measurement ${LEGM:0:12}) now"; exit 3; }
OLDID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$E")
OSER=$PROD/guestd-root/$OLDID/$OLDID.serial
[ -r "$OSER" ] && cp "$OSER" $ST/$ID-old.serial || { say "REFUSING: cannot keep the legacy guest's serial"; exit 3; }
# hookbin's leak CONTROL: on 79c5ecf2 its front logs the app's unsolicited HEAD body verbatim ("Unsolicited response ...")
if [ "$ID" = 0ddbd824 ]; then
  [ "$(serial_clean $ST/$ID-old.serial | grep -c 'Unsolicited response' || [ $? = 1 ])" -ge 1 ] || { say "REFUSING: the leak control fails: hookbin's 79c5ecf2 serial holds no 'Unsolicited response' line"; exit 3; }
fi
OLDSERIAL=$(cert_serial $HOST) && [ -n "$OLDSERIAL" ] || { say "REFUSING: cannot read the public certificate's serial"; exit 3; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S')
python3 - "$E" "$T0" "$OLDSERIAL" $ST/$ID-vms-before.json $ST/$ID-before.json "$RELM" <<'PY'
import json,sys
e,t0,ser,vf,out,relm=sys.argv[1:]; e=json.loads(e); vms=json.load(open(vf))
others=sorted([v["name"],v["id"],v["createdAt"],v["transportKeySha256"]] for v in vms if v["name"]!=e["name"])
json.dump({"t0":t0,"oldId":e["id"],"oldKey":e["transportKeySha256"],"oldCreatedAt":e["createdAt"],"oldSerial":ser,"others":others,"relm":sys.argv[6]},open(out,"w"),indent=1)
PY
say "5e $ID: 79c5ecf2 release guest $OLDID (${LEGM:0:12}) -> 52156652 predicted ${RELM:0:12}; certificate serial $OLDSERIAL; the OWNER's restart now (T0 $T0 UTC)"
set +e
( H=$(mktemp -d); trap 'rm -rf "$H"' EXIT; cd /home/steven/Projects/enclave && HOME="$H" node cli/enclave.mjs --base https://api.enclave.host/t/metal-iso0 restart "$FULL" ) > $ST/$ID-restart.txt 2>&1
rc=$?; set -e; unset ENCLAVE_KEY
say "5e $ID: enclave restart exited $rc: $(tr '\n' ' ' < $ST/$ID-restart.txt | cut -c1-200)"
[ $rc = 0 ] || { say "5e $ID: the restart was not accepted; nothing changed on the node? check guestd before retrying ($ST/$ID-before.json kept: remove it to retry)"; exit 4; }
U=e5-proofs-$ID-$(date -u +%Y%m%dT%H%M%SZ)
env -u ENCLAVE_KEY systemd-run --user --unit="$U" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0" "$1"; echo $? > "$2"' $E4/e5-proofs.sh "$ID" "$ST/$ID-proofs.rc"
say "5e $ID: the five proofs + the 10-min observe run DETACHED as $U (exit code -> $ST/$ID-proofs.rc); follow: tail -f $LOG4"
