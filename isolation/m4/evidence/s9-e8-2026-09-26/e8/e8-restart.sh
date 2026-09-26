#!/usr/bin/env bash
# The aee2059f relaunch for ONE canary (0ddbd824, then 395bed3e, then 4e62e60d), after S9: its preconditions (guestd is
# guestd.4cd26e58 on iso-4cd26e58 with the S9 epoch; the node attests N2; the canary is its 5db18199 release guest; the
# relay predicts AND admits aee2059f for it = the pinned independent value in state/pins.txt, e8-pins.sh), a snapshot
# (with the relay's predicted runtime id), the OWNER's restart through the node base, then e8-proofs.sh DETACHED. The key
# ONLY from this process's environment as ENCLAVE_KEY. Run e.g.
#   bash -ic 'ENCLAVE_KEY="$ETH_AGENT_WALLET" ~/enclave-bench/e8-20260926/e8-restart.sh 0ddbd824'
# Derived from e7-restart.sh. Nothing here rolls back: a failed proof HOLDs (e8-proofs.sh).
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e8-20260926/lib-e8.sh
ID=${1:?0ddbd824, 395bed3e or 4e62e60d}; canary "$ID" || { echo "unknown canary $ID"; exit 2; }
[[ "${ENCLAVE_KEY:-}" =~ ^(0x)?[0-9a-fA-F]{64}$ ]] || { say "REFUSING: ENCLAVE_KEY (the agent wallet, 64 hex) is not in this process's environment"; exit 2; }
# one canary at a time, in order, each only once
[ -z "$PREV" ] || [ -f $ST/accepted-$PREV ] || { say "REFUSING: $PREV is not accepted yet (order: 0ddbd824, 395bed3e, 4e62e60d)"; exit 2; }
[ ! -e $ST/$ID-before.json ] && [ ! -e $ST/accepted-$ID ] || { say "REFUSING: e8 already ran for $ID ($ST/$ID-before.json)"; exit 2; }
# the first relaunch starts from the LATEST accepted keys exactly: n2acc's once it accepted (hookbin's new key), else e7's
SEED=~/enclave-bench/e7-20260926/state; [ -f ~/enclave-bench/n2acc-20260926/state/accepted-0ddbd824 ] && SEED=~/enclave-bench/n2acc-20260926/state
[ -n "$PREV" ] || { cmp -s $ST/canary-keys.txt $SEED/canary-keys.txt && cmp -s $TSV4 $SEED/canaries.tsv; } \
  || { say "REFUSING: e8's seeded state is not the latest accepted state ($SEED)"; exit 2; }
# the independent aee2059f pin for THIS canary, from e8-pins.sh
grep -qx "$ID $RELM bundle [0-9a-f]\{64\}" $ST/pins.txt 2>/dev/null || { say "REFUSING: no e8-pins.sh record of ${RELM:0:12} for $ID (run e8-pins.sh)"; exit 2; }
systemctl --user list-units --plain --no-legend --all 'e4-*' 'e5-*' 'e6-*' 'e7-*' 'e8-*' 'n2acc-*' 'n2b-apply-*' 'rr-*-apply-*' 's4c*-apply-*' 's?t-apply-*' | grep -q . && { say "REFUSING: a rollout unit is active"; exit 2; }
X=$(systemctl --user show enclave-guestd.service -p ExecStart --value) && grep -Fq -- "path=$NBIN ;" <<<"$X" && grep -Fq -- " -isolation $NEWT/isolation " <<<"$X" \
  || { say "REFUSING: guestd is not $NBIN on $NEWT (run S9 first)"; exit 2; }
[ -r ~/enclave-bench/fl-20260926/state/s9-switched-epoch ] || { say "REFUSING: no S9 epoch (S9 not applied, or rolled back: s9t-rollback.sh removes it)"; exit 2; }
# the node is N2 (its judge certifies the aee2059f guests: b4's pairing rule), on the unchanged launcher
[ "$(node_attested)" = "$NODEM $NODEC" ] && node_runs_from "$LW" "$LAUNCH_SHA" || { say "REFUSING: the node does not attest N2 (${NODEM:0:12} / 6845565a) on launcher 578be084"; exit 3; }
relay_row_ok || { say "REFUSING: the relay does not list metal-iso0 serving and eligible"; exit 3; }
for id in $CAN; do rstat_listed $id || { say "REFUSING: release-status for ${id:0:10} is not listed:true (step 2)"; exit 3; }; done
check_guestd4 || { say "REFUSING: guestd is not the 3 canaries with 4e's expected keys"; exit 3; }
noncanary_empty || { say "REFUSING: a non-canary deployment is (or may be) on metal-iso0"; exit 3; }
wait_for 60 public_ok4 || { say "REFUSING: the canaries do not serve with 4e's expected keys"; exit 3; }
[[ "$RELM" =~ ^[0-9a-f]{96}$ ]] && [ "$RELM" != "$LEGM" ] || { say "REFUSING: no pinned aee2059f measurement for $ID"; exit 3; }
M=$(expected_rel $FULL) && [ "$M" = "$RELM" ] || { say "REFUSING: the relay's aee2059f prediction for $ID is '${M:-none}', not the independently computed ${RELM:0:12}"; exit 3; }
RTID=$(expected_rt $FULL) || { say "REFUSING: the relay's aee2059f image for $ID names no runtime id"; exit 3; }
vms4 > $ST/$ID-vms-before.json || { say "REFUSING: guestd unreadable"; exit 3; }
E=$(entry4 $FULL) || { say "REFUSING: no single guestd entry for $ID"; exit 3; }
python3 -c "import json,sys; e=json.loads(sys.argv[1]); sys.exit(0 if e['status']=='running' and e['measurement']=='$LEGM' and e.get('release') is True else 1)" "$E" \
  || { say "REFUSING: $ID is not its running 5db18199 RELEASE guest (measurement ${LEGM:0:12}) now"; exit 3; }
OLDID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$E")
OSER=$PROD/guestd-root/$OLDID/$OLDID.serial
[ -r "$OSER" ] && cp "$OSER" $ST/$ID-old.serial || { say "REFUSING: cannot keep the legacy guest's serial"; exit 3; }
# no leak control here: the current guests already run the console guard; proof 6 stays as a regression check
OLDSERIAL=$(cert_serial $HOST) && [ -n "$OLDSERIAL" ] || { say "REFUSING: cannot read the public certificate's serial"; exit 3; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S')
python3 - "$E" "$T0" "$OLDSERIAL" $ST/$ID-vms-before.json $ST/$ID-before.json "$RELM" "$RTID" <<'PY'
import json,sys
e,t0,ser,vf,out,relm,rtid=sys.argv[1:]; e=json.loads(e); vms=json.load(open(vf))
others=sorted([v["name"],v["id"],v["createdAt"],v["transportKeySha256"]] for v in vms if v["name"]!=e["name"])
json.dump({"t0":t0,"oldId":e["id"],"oldKey":e["transportKeySha256"],"oldCreatedAt":e["createdAt"],"oldSerial":ser,"others":others,"relm":relm,"runtimeId":rtid},open(out,"w"),indent=1)
PY
say "8e $ID: 5db18199 release guest $OLDID (${LEGM:0:12}) -> aee2059f predicted ${RELM:0:12} (runtime ${RTID:0:12}); certificate serial $OLDSERIAL; the OWNER's restart now (T0 $T0 UTC)"
set +e
( H=$(mktemp -d); trap 'rm -rf "$H"' EXIT; cd /home/steven/Projects/enclave && HOME="$H" node cli/enclave.mjs --base https://api.enclave.host/t/metal-iso0 restart "$FULL" ) > $ST/$ID-restart.txt 2>&1
rc=$?; set -e; unset ENCLAVE_KEY
say "8e $ID: enclave restart exited $rc: $(tr '\n' ' ' < $ST/$ID-restart.txt | cut -c1-200)"
[ $rc = 0 ] || { say "8e $ID: the restart was not accepted; nothing changed on the node? check guestd before retrying ($ST/$ID-before.json kept: remove it to retry)"; exit 4; }
U=e8-proofs-$ID-$(date -u +%Y%m%dT%H%M%SZ)
env -u ENCLAVE_KEY systemd-run --user --unit="$U" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0" "$1"; echo $? > "$2"' $E4/e8-proofs.sh "$ID" "$ST/$ID-proofs.rc"
say "8e $ID: the proofs (1-9) + the 10-min observe run DETACHED as $U (exit code -> $ST/$ID-proofs.rc); follow: tail -f $LOG4"
