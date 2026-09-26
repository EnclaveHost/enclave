#!/usr/bin/env bash
# Verify, READ-ONLY, a 4e restart that was made WITHOUT e4-restart.sh (its snapshot rebuilt from recorded facts), by
# running e4-proofs.sh in the foreground: the five proofs, then the 10-min observe; 4e's state/ is updated only on a pass.
#   e4-verify.sh <id8> "<T0 UTC, before the restart>" <old guest id> <old certificate serial>
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e4-20260925/lib-e4.sh
ID=${1:?}; T0=${2:?}; OLDID=${3:?}; OLDSERIAL=${4:?}; canary "$ID" || exit 2
[ ! -e $ST/$ID-before.json ] && [ ! -e $ST/accepted-$ID ] || { say "REFUSING: $ST/$ID-before.json exists"; exit 2; }
[[ "$T0" =~ ^2026-[0-9]{2}-[0-9]{2}\ [0-9:]{8}$ ]] && [[ "$OLDID" =~ ^gd[0-9a-f]{8}$ ]] && [[ "$OLDSERIAL" =~ ^[0-9A-F]{16,40}$ ]] || { say "bad arguments"; exit 2; }
OLDKEY=$(awk -v l=$ID '$1==l{print $2}' $KEYS4); [[ "$OLDKEY" =~ ^[0-9a-f]{64}$ ]] || { say "no expected key for $ID in $KEYS4"; exit 2; }
vms4 > $ST/$ID-vms-before.json || { say "guestd unreadable"; exit 3; }
python3 - "$FULL" "$T0" "$OLDID" "$OLDKEY" "$OLDSERIAL" $ST/$ID-vms-before.json $ST/$ID-before.json <<'PY'
import json,sys
full,t0,oid,okey,ser,vf,out=sys.argv[1:]; vms=json.load(open(vf))
others=sorted([v["name"],v["id"],v["createdAt"],v["transportKeySha256"]] for v in vms if v["name"].lower()!=full.lower())
json.dump({"t0":t0,"oldId":oid,"oldKey":okey,"oldCreatedAt":None,"oldSerial":ser,"others":others,"rebuilt":True},open(out,"w"),indent=1)
PY
say "4e $ID: VERIFY a restart made outside e4-restart.sh (T0 $T0 UTC, old guest $OLDID, old serial $OLDSERIAL)"
E4_VERIFY=1 exec $E4/e4-proofs.sh "$ID"
