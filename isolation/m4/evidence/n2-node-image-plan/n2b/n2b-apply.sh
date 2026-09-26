#!/usr/bin/env bash
# N2-b: point metal/config.iso.json's `dist` at the N2 node image (~/enclave-prod/dist-iso-6845565a; prediction fab9c6c7),
# nothing else, in ONE node CVM restart (enclave-87's approved plan abb87c12: N2-b directly, N1-b skipped). Derived from
# the reviewed and run s4ccb-apply.sh (4c-c-b), minus its launcher move: the launcher (metal-578be084, 4620da5d) and
# its drop-in stay as they are and are only asserted. The guests are guestd's and keep running; the new supervisor
# ADOPTS them. Run DETACHED via n2b-run.sh, after the combined relay window (rs-11 + N1-a + N2-a) is ACCEPTED and d1's GO.
# Any failed check after the change rolls back (n2b-rollback.sh: the byte-exact backup, dist-iso-f6cbd75a).
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh
source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e7-20260926/lib-e7.sh; source ~/enclave-bench/n2-20260926/libn2.sh
trap '' HUP PIPE
trap 'say "N2-b: terminated before any change"; exit 143' TERM INT
grep -qE '^0::/.*/n2b-apply-[0-9]{8}T[0-9]{6}Z\.service$' /proc/self/cgroup || { say "REFUSING: run N2-b detached, through n2b-run.sh"; exit 2; }
# ---- preflight: every check before the first mutation, all fail closed
check_image_n2 || exit 2
[ "$(unit_wd)" = "$LW" ] && node_runs_from "$LW" "$LAUNCH_SHA" || { say "REFUSING: the node does not run the reviewed launcher (4620da5d) from $LW"; exit 2; }
[ -f "$DROP" ] && [ "$(cat "$DROP")" = "$DROP_BODY" ] || { say "REFUSING: the launcher drop-in is not 4c-c-b's"; exit 2; }
[ "$(python3 -c "import json;print(json.load(open('$C'))['cpus'])")" = 4 ] || { say "REFUSING: config cpus is not 4 (the prediction is for 4 vCPUs)"; exit 2; }
[ "$(python3 -c "import json;print(json.load(open('$C'))['dist'])")" = "$OLDD" ] || { say "REFUSING: dist is not the live f6cbd75a image"; exit 2; }
python3 -c "import json,sys; c=json.load(open('$C')); sys.exit(0 if c['isolation'].get('release') is True else 1)" || { say "REFUSING: isolation.release is not true (4c-c's opt-in)"; exit 2; }
allow_has "$NEWM" "$OLDM" || { say "REFUSING: the relay does not allowlist N2 ${NEWM:0:12} beside the live ${OLDM:0:12} (the combined relay window first)"; exit 3; }
[ -e "$CBN" ] && { say "REFUSING: $CBN exists (N2-b already ran?)"; exit 4; }
read -r am ao <<<"$(node_attested)" || true; [ "${am:-}" = "$OLDM" ] && [ "${ao:-}" = "$OLDC" ] || { say "REFUSING: the node does not attest ${OLDM:0:12} / f6cbd75a now"; exit 5; }
systemctl --user list-units --plain --no-legend --all 's?t-apply-*' 'e[0-9]-*' 'n2*-apply-*' 's4c*-apply-*' 'rr-*-apply-*' 'm2-lb*' | grep -v "n2b-apply-" | grep -q . && { say "REFUSING: another rollout unit or a lab is active"; exit 6; }
check_guestd4 >/dev/null || { say "REFUSING: guestd is not the 3 canaries on their e7 keys at 65536/1600"; exit 6; }
noncanary_empty || { say "REFUSING: a non-canary deployment is (or may be) on metal-iso0 (the auto-rollback would be refused)"; exit 6; }
mem_gate || { say "NO-GO: the host memory gate"; exit 6; }
avail_n2 || { say "REFUSING: the availability is not 64/16, free 0.7"; exit 7; }
wait_for 60 public_ok4 || { say "REFUSING: the canaries do not serve on their e7 keys now"; exit 7; }
eg_canaries_ok || { say "REFUSING: the relay does not list 5db18199 admitted for every canary"; exit 8; }
systemctl --user list-units --plain --no-legend --all 'fl-check-*' | grep -q . && { say "REFUSING: one of Steven's first launches is being checked now (an fl-check unit is active)"; exit 8; }
# ---- the change: dist only, atomically; from here every failure rolls back with a one-time token
TOKV=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
( umask 077; echo "$TOKV" > "$TOKN" ) || { say "REFUSING: cannot write the rollback token"; exit 9; }
cp -p "$C" "$CBN"; chmod 600 "$CBN"
T0="before the restart"
fail() { set +e; trap '' TERM INT; say "N2-b CHECK FAILED: $* -> rolling back to dist-iso-f6cbd75a"; FROM_APPLY="$TOKV" FROM_APPLY_WHY="N2-b at $T0: $*" "$N2D/n2b-rollback.sh"; local rc=$?; [ $rc = 0 ] && exit 20
  say "ROLLBACK FAILED rc=$rc: ESCALATE to enclave-87 (backup $CBN)"; exit 24; }
trap 'fail "terminated (TERM/INT) after the change began"' TERM INT
python3 - "$C" "$OLDD" "$NEWD" "$EV/secret/config.iso.json.new" <<'PY' || { if cmp -s "$C" "$CBN"; then mv "$CBN" "$CBN.unused-$(date -u +%Y%m%dT%H%M%SZ)"; rm -f "$TOKN"; say "N2-b: the config edit failed and the config is unchanged: nothing restarted"; exit 21; fi; fail "the config edit"; }
import sys,os,json
p,old,new,tmp=sys.argv[1:]; a=json.load(open(p)); assert a["dist"]==old
b=json.loads(json.dumps(a)); b["dist"]=new
assert {k:v for k,v in a.items() if k!="dist"}=={k:v for k,v in b.items() if k!="dist"}   # exactly one change: dist
t=json.dumps(b,indent=2)+"\n"
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.write(fd,t.encode()); os.close(fd); os.replace(tmp,p)   # same filesystem: atomic
PY
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(c.isolation.release===true && c.dist===process.argv[2] ? 0 : 1)' "$C" "$NEWD" \
  || fail "the edited config is not what the launcher must read (isolation.release === true, dist N2)"
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say "N2-b: dist -> dist-iso-6845565a (N2, ${NEWM:0:16}); restarting enclave-metal-iso (the node CVM reboots; guests keep running)"
systemctl --user restart enclave-metal-iso.service || fail "restart"
wait_for 30 node_runs_from "$LW" "$LAUNCH_SHA" || fail "the node does not run the reviewed launcher from $LW"
attested_new() { [ "$(node_attested)" = "$NEWM $NEWC" ]; }
wait_for 600 attested_new || fail "the node never attested ${NEWM:0:12} with overlay 6845565a"
say "N2-b: the node ATTESTS ${NEWM:0:16} (raw report 0x90), overlay 6845565a, launcher 578be084 from $LW"
wait_for 120 relay_row_ok || fail "the relay does not list metal-iso0 serving and eligible"
wait_for 300 avail_n2 || fail "availability is not 64/16, free 0.7"
wait_for 300 public_ok4 || fail "the canaries do not serve on their e7 keys"
check_guestd4 >/dev/null || fail "guestd lost a canary or a key changed (a resume relaunched one?)"
journalctl --user -u enclave-metal-iso.service --since "$T0" --no-pager -o cat > $N2D/n2b-node-journal.txt 2>&1 || true
na=$(grep -c 'adopted guest' $N2D/n2b-node-journal.txt || true)
nr=$(grep -ciE 'released [0-9x]|\[claim\] release 0x|shutdown: releasing|releaseLease' $N2D/n2b-node-journal.txt || true)
say "N2-b: node journal: $na adopted-guest lines, $nr release lines"
[ "$na" -ge 3 ] && [ "$nr" = 0 ] || fail "the resumes did not adopt the 3 canaries (adopted $na, released $nr)"
grep -qE '^\[enclave-metal\] isolation snp-guest-per-app: attested release OPTED IN' $N2D/n2b-node-journal.txt || fail "the HOST launcher did not report the attested-release opt-in"
grep -qE '^\[gsup\] per-app isolation tier snp-guest-per-app: .*attested release OPTED IN' $N2D/n2b-node-journal.txt || fail "gsup (the guest) did not report the attested-release opt-in"
! grep -qE '^\[isolation\] 0x[0-9a-f]+.*(REFUSED|not an eligible|is no predicted image|did not verify)' $N2D/n2b-node-journal.txt || fail "a certificate refusal line in the node journal"
node_runs_from "$LW" "$LAUNCH_SHA" || fail "the node no longer runs the reviewed launcher from $LW (it restarted?)"
rm -f "$TOKN"; trap - TERM INT
say "N2-b APPLIED and checked (restart at $T0). Next: the 10-min gate, then the hookbin acceptance relaunch (n2acc); rollback = n2b-rollback.sh (OVERRIDE after n2acc)"
