#!/usr/bin/env bash
# 4c-b: point metal/config.iso.json's dist at the 4c image (dist-iso-b18f8989), nothing else; the node CVM restarts and
# its NEW supervisor (b18f8989) resumes the 3 canaries' leases by ADOPTING their running guests (same record). guestd,
# the guests and the relay are untouched. After it the published availability carries the floor's verdict. The release
# stays OFF (the supervisor never sets ISOLATION_RELEASE). Run DETACHED via s4c-run.sh b, after 4c-a.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4c.sh
trap '' HUP PIPE
trap 'say "4c-b: terminated before any change"; exit 143' TERM INT
grep -qE '^0::/.*/s4cb-apply-[0-9]{8}T[0-9]{6}Z\.service$' /proc/self/cgroup || { say "REFUSING: run 4c-b detached, through s4c-run.sh b"; exit 2; }
check_prediction4c || exit 2
[ "$(python3 -c "import json;print(json.load(open('$C'))['cpus'])")" = 4 ] || { say "REFUSING: config cpus is not 4 (the prediction is for 4 vCPUs)"; exit 2; }
[ "$(python3 -c "import json;print(json.load(open('$C'))['dist'])")" = "$OLDD" ] || { say "REFUSING: dist is not the S2 image"; exit 2; }
[ "$(allowlist)" = "METAL_ALLOWED_MEASUREMENTS=$PREM,$OLDM,$NEWM" ] || { say "REFUSING: the relay does not allowlist the 4c image (run 4c-a first)"; exit 3; }
[ -e "$CB4" ] && { say "REFUSING: $CB4 exists (4c-b already ran?)"; exit 4; }
read -r am ao <<<"$(node_attested)" || true; [ "${am:-}" = "$OLDM" ] && [[ "${ao:-}" == c42612c0* ]] || { say "REFUSING: the node does not attest 10622d98 / c42612c0 now"; exit 5; }
check_guestd pool64 || { say "REFUSING: guestd is not at 65536/1600 with the 3 S0 canaries"; exit 6; }
noncanary_empty || { say "REFUSING: a non-canary deployment is (or may be) on metal-iso0 (the auto-rollback would be refused)"; exit 6; }
avail_before || { say "REFUSING: the availability is not the pre-4c shape"; exit 7; }
wait_for 60 public_ok || { say "REFUSING: the canaries do not serve now"; exit 7; }
# the 4c supervisor's cert gate asks the relay for each canary's prediction: it must answer now (the relay slice)
~/enclave-bench/relay-slice-20260925/accept.sh > $S4C/4cb-accept-before.txt 2>&1 || { say "REFUSING: the relay's expected-guest acceptance fails (4cb-accept-before.txt)"; exit 8; }
# ---- the change: dist only, atomically; from here every failure rolls back with a one-time token
TOK=$EV/secret/4c-rollback-token; TOKV=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
( umask 077; echo "$TOKV" > "$TOK" ) || { say "REFUSING: cannot write the rollback token"; exit 9; }
cp -p "$C" "$CB4"; chmod 600 "$CB4"
T0="before the restart"
fail() { set +e; trap '' TERM INT; say "4c-b CHECK FAILED: $* -> rolling back to dist-iso-c42612c0"; FROM_APPLY="$TOKV" FROM_APPLY_WHY="4c-b at $T0: $*" "$S4C/s4cb-rollback.sh"; local rc=$?; [ $rc = 0 ] && exit 20; say "ROLLBACK FAILED rc=$rc: ESCALATE to Codex (backup $CB4)"; exit 24; }
trap 'fail "terminated (TERM/INT) after the change began"' TERM INT
python3 - "$C" "$OLDD" "$NEWD" "$EV/secret/config.iso.json.new" <<'PY' || { if cmp -s "$C" "$CB4"; then mv "$CB4" "$CB4.unused-$(date -u +%Y%m%dT%H%M%SZ)"; rm -f "$TOK"; say "4c-b: the config edit failed and the config is unchanged: nothing restarted"; exit 21; fi; fail "the config edit"; }
import sys,os,json
p,old,new,tmp=sys.argv[1:]; s=open(p).read(); q='"%s"'%old
assert s.count(q)==1, "dist is not exactly the live image"; t=s.replace(q,'"%s"'%new)
a,b=json.loads(s),json.loads(t); assert b["dist"]==new and {k:v for k,v in a.items() if k!="dist"}=={k:v for k,v in b.items() if k!="dist"}
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.write(fd,t.encode()); os.close(fd); os.replace(tmp,p)   # same filesystem: atomic
PY
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say "4c-b: dist -> dist-iso-b18f8989; restarting enclave-metal-iso (the node CVM reboots)"
systemctl --user restart enclave-metal-iso.service || fail "restart"
attested_new() { [ "$(node_attested)" = "$NEWM $NEWC" ]; }
wait_for 600 attested_new || fail "the node never attested ${NEWM:0:12} with overlay b18f8989"
say "4c-b: the node ATTESTS ${NEWM:0:16} (raw report 0x90), overlay b18f8989"
wait_for 120 relay_row_ok || fail "the relay does not list metal-iso0 serving and eligible"
wait_for 300 avail4c || fail "availability is not 64/16, free 0.7, with the floor verdict {16384, admitsSmallestGuest true}"
wait_for 300 public_ok || fail "the canaries do not serve with their S0 keys"
check_guestd pool64 || fail "guestd lost a canary or a key changed (a resume relaunched one?)"
journalctl --user -u enclave-metal-iso.service --since "$T0" --no-pager -o cat > $S4C/4cb-node-journal.txt 2>&1 || true
na=$(grep -c 'adopted guest' $S4C/4cb-node-journal.txt || true); nr=$(grep -ciE 'released [0-9x]|releaseLease' $S4C/4cb-node-journal.txt || true)
say "4c-b: node journal: $na adopted-guest lines, $nr release lines"
[ "$na" -ge 3 ] && [ "$nr" = 0 ] || fail "the resumes did not adopt the 3 canaries (adopted $na, released $nr)"
rm -f "$TOK"; trap - TERM INT
say "4c-b APPLIED and checked (restart at $T0). Next: observe.sh 4c (the 10-min gate); rollback = s4cb-rollback.sh, then s4ca-rollback.sh"
