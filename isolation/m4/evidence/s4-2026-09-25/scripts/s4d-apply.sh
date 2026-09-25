#!/usr/bin/env bash
# S4 row 4d, the coordinated activation: guestd -> the reviewed floor merge's binary with -release, the new tree
# (17e182a8), -legacy-isolation (the LIVE tree, 0181bce3) and Codex's host floor 16384. ONE guestd restart; the node CVM,
# its image, the relay, the chain and the budget 65536/16 stay. The live supervisor (c42612c0, ISOLATION_RELEASE unset)
# never asks for a release, so every new deployment guest is still built from 0181bce3 (5d's hardware check 023b06be:
# the hookbin canary's AppID and VCEK-signed measurement, reproduced by expected-measurement --pin 5c3561f9).
# Adoption (source, 17e182a8 = d1a38994 for guestd: persist.go adoptOne): the same conditions as c42612c0's; old records lack Release/Legacy,
# which read false; the canaries' CIDs (65536-131071) sit below guestd's new band (131072-196607).
# NOT A GO BY ITSELF. Runs only with: the image diff signed off (99/e3, d1), this script reviewed by 99/e3, s4-install.sh
# and s4-guestd-install.sh done, the legacy check covering THIS guestd, and Codex's go for the activation.
# Usage: s4d-apply.sh <guestd merge commit, 40 hex> <its sha256 from install.log>. Before it: s4d-adoption-preflight.sh
# (the same two arguments) within 2 h, and s4/legacy-check.txt for this binary.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
BINC=${1:?commit}; BSHA=${2:?sha256}; [[ "$BINC" =~ ^[0-9a-f]{40}$ && "$BSHA" =~ ^[0-9a-f]{64}$ ]] || { echo "40-hex commit, 64-hex sha"; exit 2; }
B=$PROD/bin/guestd.${BINC:0:8}; BAK=$EV/secret/enclave-guestd.service.bak-pre-4d; J=$S4/4d-guestd-journal.txt
# ---- preflight: every check before the first mutation, all of them fail closed
[ -e "$BAK" ] && { say4 "REFUSING: $BAK exists (4d already ran?)"; exit 10; }
[ -x "$B" ] && [ "$(sha256sum < "$B" | cut -c1-64)" = "$BSHA" ] || { say4 "REFUSING: $B is not the binary $BSHA"; exit 11; }
grep -qF "1c: $B sha256 $BSHA (built twice, from $BINC)" $LOG4 || { say4 "REFUSING: install.log has no 1c line for $B"; exit 11; }
# the legacy-path hardware check (5d's run-legacy-check.sh) for THIS guestd: "guestd <commit> sha256 <sha> PASS evidence <commit>"
lc=$(grep -xE "guestd $BINC sha256 $BSHA PASS evidence [0-9a-f]{40}" $S4/legacy-check.txt 2>/dev/null | tail -1) \
  && git -C $MAIN cat-file -e "${lc##* }^{commit}" 2>/dev/null || { say4 "REFUSING: no legacy-path check recorded for guestd $BINC / $BSHA with an evidence commit (s4/legacy-check.txt)"; exit 12; }
# enclave-e3 A1: the scripted ADOPTION preflight (s4d-adoption-preflight.sh) for THIS binary and tree, under 2 hours old:
# a canary that fails adoption even once is stopped and scrubbed, which no rollback undoes
ac=$(cat $S4/adoption-check.txt 2>/dev/null || true)
[[ "$ac" == "guestd $BINC sha256 $BSHA tree $IMG at "*": 3/3 canaries verify with the new tree's judge"* ]] \
  && ae=$(sed -n 's/.* epoch \([0-9]*\):.*/\1/p' <<<"$ac") && [ -n "$ae" ] && [ $(( $(date +%s) - ae )) -le 7200 ] \
  || { say4 "REFUSING: no adoption preflight for guestd $BINC / tree $IMG in the last 2 h (run s4d-adoption-preflight.sh)"; exit 12; }
tree_ok || { say4 "REFUSING: the installed tree"; exit 13; }
python3 "$T/isolation/m4/release-manifest.py" verify "$R" --expect "$REL" | grep -q "verified 15 files" || { say4 "REFUSING: $R does not verify"; exit 13; }
[ -f "$LEG/m4/build-app-guest.sh" ] && [ "$(git -C "$LEG/.." rev-parse HEAD)" = "$LEGC" ] || { say4 "REFUSING: the legacy tree is not $LEGC"; exit 13; }
reproduces || { say4 "REFUSING: 1d again (a host tool changed?)"; exit 14; }
lab_quiet || { say4 "REFUSING: this host is not quiet"; exit 15; }
avail=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
[ $(( avail - (65536 - 5376) )) -ge $FLOOR ] || { say4 "NO-GO: MemAvailable ${avail} MiB leaves < $FLOOR MiB at the full 64 GiB ceiling"; exit 16; }
awk 'BEGIN{f=1} /^some /{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){split($i,a,"="); f=(a[2]+0==0)?0:1}} END{exit f}' /proc/pressure/memory || { say4 "NO-GO: memory PSI avg60 not 0"; exit 16; }
check_guestd pool64 || { say4 "REFUSING: guestd is not at 65536/1600 with the 3 S0 canaries"; exit 17; }
noncanary_empty || { say4 "REFUSING: a non-canary deployment is (or may be) on metal-iso0: the auto-rollback would be refused"; exit 17; }
# the live ExecStart, exactly: NEWBIN and these flags, nothing else; the auth-key's VALUE is kept and never printed
python3 - "$U" "$NEWBIN" <<'PY' || { say4 "REFUSING: ExecStart is not the budget-64 line"; exit 18; }
import sys,shlex
p,nb=sys.argv[1:]; ex=[l for l in open(p).read().split("\n") if l.startswith("ExecStart=")]
assert len(ex)==1; a=shlex.split(ex[0][len("ExecStart="):]); assert a[0]==nb, a[0]
kv=dict(zip(a[1::2],a[2::2])); assert len(a)%2==1 and len(kv)==(len(a)-1)//2
want={"-isolation":"/home/steven/enclave-prod/iso-03be27d6/isolation","-root":"/home/steven/enclave-prod/guestd-root",
 "-listen":"127.0.0.1:8095","-data-listen":"127.0.0.1:8096","-gateway":"https://trustless-gateway.link","-guest-mem-mib":"65536","-guest-cpus":"16"}
assert set(kv)==set(want)|{"-auth-key"}, sorted(kv)
assert all(kv[k]==v for k,v in want.items()) and kv["-auth-key"].startswith("/")
PY
# vsock 9443/9444 free: bind-probe (this host has no vsock_diag). The last check, right before the restart; the only
# process that may take them is the guestd this script starts next.
PP=$(mktemp -d); ( cd "$T/isolation/m2" && go build -o "$PP/portprobe" ./lab-release/portprobe )
"$PP/portprobe" 9443 9444 || { rm -rf "$PP"; say4 "REFUSING: vsock 9443 or 9444 is held"; exit 19; }; rm -rf "$PP"
UNITS_BEFORE=$(units) || { say4 "REFUSING: the m2-gd* units are unreadable or not the 3 running canaries"; exit 19; }
# ---- the change: the ONE ExecStart line, atomically
TOK=$EV/secret/4d-rollback-token; TOKV=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
( umask 077; echo "$TOKV" > "$TOK" ) || { say4 "REFUSING: cannot write the rollback token"; exit 19; }
cp -p "$U" "$BAK"; chmod 600 "$BAK"
# FROM_APPLY: the preflight above verified the 3 S0 canaries alone and an empty non-canary set seconds before, and the
# live supervisor never asks for a release; so the rollback skips its gate, which needs a READABLE guestd (the one
# thing a failed 4d may not have)
fail() { set +e; say4 "4D CHECK FAILED: $* -> rolling back to guestd.c42612c0 on the live tree"; FROM_APPLY="$TOKV" FROM_APPLY_WHY="4d apply at $T0: $*" $S4/s4d-rollback.sh; exit 20; }
T0="before the restart"
python3 - "$U" "$B" "$T/isolation" "$LEG" "$FLOOR" <<'PY' || { if cmp -s "$U" "$BAK"; then mv "$BAK" "$BAK.unused-$(date -u +%Y%m%dT%H%M%SZ)"; rm -f "$TOK"; say4 "4D: the unit edit failed and the unit is unchanged: nothing restarted"; exit 21; fi; fail "the unit edit"; }
import sys,os,shlex
p,b,iso,leg,floor=sys.argv[1:]; lines=open(p).read().split("\n"); i=[n for n,l in enumerate(lines) if l.startswith("ExecStart=")][0]
a=shlex.split(lines[i][len("ExecStart="):]); a[0]=b; a[a.index("-isolation")+1]=iso
a+=["-release","-legacy-isolation",leg,"-instance-prefix","gd","-guest-host-floor-mib",floor]
lines[i]="ExecStart="+" ".join(a)   # every argument is a plain path/flag/number: no quoting needed (asserted)
assert all(shlex.quote(x)==x for x in a)
open(p+".new","w").write("\n".join(lines)); os.replace(p+".new",p)
PY
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "4D: daemon-reload + restart (guestd.${BINC:0:8} -release, tree 17e182a8, legacy 0181bce3, floor $FLOOR)"
systemctl --user daemon-reload || fail "daemon-reload"
systemctl --user restart enclave-guestd.service || fail "restart"
X=$(systemctl --user show enclave-guestd.service -p ExecStart --value) || fail "ExecStart unreadable after the restart"
for s in "path=$B ;" " -isolation $T/isolation " " -release " " -legacy-isolation $LEG " " -guest-host-floor-mib $FLOOR " " -guest-mem-mib 65536 -guest-cpus 16 "; do
  echo "$X" | grep -Fq -- "$s" || fail "ExecStart lacks '$s'"
done
# enclave-e3 A2: Restart=on-failure would re-run adoption every 10 s; fail AT ONCE on a restart, or on a guest the new
# guestd dropped or stopped, instead of waiting out the 300 s
watch4d() {
  local end=$(( $(date +%s) + 300 )) nr
  while :; do
    nr=$(systemctl --user show enclave-guestd.service -p NRestarts --value 2>/dev/null) || return 2
    [ "$nr" = 0 ] || { say4 "4D: guestd restarted ($nr)"; return 2; }
    journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > "$J" 2>/dev/null || true
    grep -qE "not adopted, ended|stopped [0-9]+ guest unit" "$J" && { say4 "4D: the new guestd dropped or stopped a guest"; return 2; }
    check_guestd pool64 && return 0
    [ $(date +%s) -ge $end ] && return 1
    sleep 5
  done
}
watch4d || fail "guestd did not come back at 65536/1600 with the 3 same canaries (same keys), or restarted, or dropped a guest"
# /health: release ON with the legacy image; config/secrets/egress STAY off (the supervisor's claim gate is unchanged);
# the floor is 16384 and MemAvailable leaves room for the smallest guest above it; nothing is starting
python3 - $EV/.guestd.json $FLOOR <<'PY' || fail "/health supports or pool.host"
import json,sys
h=json.load(open(sys.argv[1]))[0]["body"]; fl=int(sys.argv[2]); s=h.get("supports",{}); ho=(h.get("pool") or {}).get("host") or {}
assert s.get("release") is True and s.get("legacyImage") is True, s
assert not any(s.get(k) for k in ("config","secrets","egress","configCid","ports","gpu")), s
assert ho.get("floorMiB")==fl and isinstance(ho.get("memAvailableMiB"),int) and ho["memAvailableMiB"]>=fl+1792, ho
# every running guest's unit memory was read (d36e8da7): pending is then what the 3 canaries may still draw, under 3 x 1792
assert ho.get("unreadUnits")==0 and isinstance(ho.get("pendingMiB"),int) and 0<=ho["pendingMiB"]<3*1792, ho
PY
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] && systemctl --user is-active --quiet enclave-guestd.service || fail "not active, or restarted"
journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > $J 2>&1 || true
for l in "adopted 3 guest(s)" "guest pool: 3 guest(s) hold 5376 MiB / 300% CPU of 65536 MiB / 1600% CPU" \
         "host memory floor $FLOOR MiB: MemAvailable now" "non-release deployment guests are built from $LEG" \
         "attested release ON: tickets on vsock 9444, egress on vsock 9443"; do
  grep -qF "$l" $J || fail "the journal lacks: $l"
done
! grep -qE "not adopted, ended|stopped [0-9]+ guest unit" $J || fail "the journal shows a guest dropped or stopped"
UA=$(units) || fail "the m2-gd* units are unreadable after the restart"; [ "$UA" = "$UNITS_BEFORE" ] || fail "the m2-gd* units changed (FATAL diff)"
wait_for 120 public_ok || fail "the canaries do not serve"
avail64() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 else 1)"; }
wait_for 180 avail64 || fail "the supervisor's availability changed (64 GiB / 16, free 0.7 expected)"
read -r am ac <<<"$(node_attested)" || true; [ "${am:-}" = "$NEWM" ] && [[ "${ac:-}" == c42612c0* ]] || fail "the node CVM's attested measurement or overlay moved"
relay_row_ok || fail "the relay does not list metal-iso0 serving and eligible"
rm -f "$TOK"
say4 "4D APPLIED and checked (restart at $T0). Next: observe.sh 4d (the 10-min gate); rollback = s4/s4d-rollback.sh"
