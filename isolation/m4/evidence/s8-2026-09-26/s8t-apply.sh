#!/usr/bin/env bash
# S8: guestd UPGRADE + TREE SWITCH to release 5db18199 (image 0c087de8: per-release W^X, the runtime self-test stated at
# attest; enclave-53's build, bf reviewed; enclave-87's queue). ONE guestd restart that moves TWO things: the binary
# guestd.4e78ba80 (0ee7ed91) -> guestd.0c087de8 (built from the release's own commit by s8-guestd-install.sh, reproduced
# by a reviewer), and -isolation iso-b63c2def (f7888d86) -> iso-0c087de8 (installed inert by s8-install.sh); it ADDS the
# per-release naming flags (-isolation-release, -legacy-isolation-release, -unrecorded-releases; lib8.sh) and changes
# nothing else. The 3 canaries are RELEASE guests on f7888d86 whose records name no release (4e78ba80 wrote them): the
# restart re-adopts them by their RECORDED measurement with the NEW judge, told -unrecorded-releases
# (s8-adoption-preflight.sh proves exactly that first); they move to 5db18199 at each canary's owner restart afterwards
# (the e7 scripts), one at a time. The node check is 4c-c's; the rollback (s8t-rollback.sh) restores the guestd.4e78ba80
# / iso-b63c2def unit (binary AND tree, no new flags). Any NEW guest after the switch (Steven's first launches included)
# builds 5db18199. Run DETACHED through s8t-run.sh, after the relay predicts AND admits 5db18199 for the 3 canaries.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e6-20260926/lib-e6.sh; source ~/enclave-bench/s8-20260926/lib8.sh
S4OLD=~/enclave-bench/pool-rollout-20260925/s4
# enclave-bf: lib8.sh is sourced LAST (lib-e6.sh sets REL/LOG4/say for e6), and REL and LOG4 are re-pinned and REL
# asserted against the installed release, so no later source can clobber the release this switch is about
REL=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; LOG4=$S4/install.log
[ "$(sha256sum < "$R/release.json" | cut -c1-64)" = "$REL" ] && [ "$T" = /home/steven/enclave-prod/iso-0c087de8 ] && [ "$OT" = /home/steven/enclave-prod/iso-b63c2def ] || { echo "REFUSING: REL/T/OT are not the S8 switch's"; exit 2; }
trap '' HUP PIPE
trap 'say4 "8T: terminated before any change"; exit 143' TERM INT
# S8 changes the BINARY too: FROM the live guestd.4e78ba80 (OBIN/OBSHA) on iso-b63c2def (OT/OIMG), TO guestd.0c087de8
# (NBIN, installed inert by s8-guestd-install.sh; its sha is the one its 1c line records, a reviewer reproduced it)
BINC=$NBINC; BSHA=$(sed -n "s|^.*1c: $NBIN sha256 \([0-9a-f]\{64\}\) (built twice, from $NBINC)\$|\1|p" $S4/install.log 2>/dev/null | tail -1)
[[ "$BSHA" =~ ^[0-9a-f]{64}$ ]] || { echo "REFUSING: no 1c line for $NBIN in $S4/install.log (run s8-guestd-install.sh)"; exit 11; }
grep -qE '^0::/.*/s8t-apply-[0-9]{8}T[0-9]{6}Z\.service$' /proc/self/cgroup || { say4 "REFUSING: run the tree switch detached, through s8t-run.sh"; exit 2; }
[ "$IMG" != "$OIMG" ] && [ "$T" != "$OT" ] || { say4 "REFUSING: lib8.sh names the live tree as the target"; exit 2; }
B=$PROD/bin/guestd.${BINC:0:8}; BAK=$EV/secret/enclave-guestd.service.bak-pre-8t; J=$S4/8t-guestd-journal.txt
# ---- preflight: every check before the first mutation, all of them fail closed
[ -e "$BAK" ] && { say4 "REFUSING: $BAK exists (the switch already ran?)"; exit 10; }
[ -x "$B" ] && [ "$(sha256sum < "$B" | cut -c1-64)" = "$BSHA" ] || { say4 "REFUSING: $B is not the binary $BSHA"; exit 11; }
[ -x "$OBIN" ] && [ "$(sha256sum < "$OBIN" | cut -c1-64)" = "$OBSHA" ] || { say4 "REFUSING: the rollback binary $OBIN is not $OBSHA"; exit 11; }
# The LEGACY path (enclave-87's ruling, 09-26): no new lab run. s4's legacy-check.txt was for guestd 4e78ba80 with a
# byte-equal boot path; S8 changes the binary AND the tree's judge/client, so that record is superseded. Accepted on b4's
# run of the new judge on the legacy form (under LEGACY_WX_RELEASES), plus the first-occurrence tripwire (the first
# legacy-path launch after S8 is checked and reported to enclave-87). No legacy guest runs now.
# The boot path: EXACTLY judge.mjs and client.mjs differ between the trees (the per-release W^X), nothing else of it.
bp=$(git -C $MAIN diff --name-only "$OIMG" "$IMG" -- isolation/m2/run-domain.sh isolation/m1 isolation/m2/fwd isolation/m2/client.mjs \
    isolation/m2/judge.mjs relay/snp-verify.mjs isolation/m2/vsock isolation/contract/runtime-identity.sh test/fixtures/amd) \
  || { say4 "REFUSING: the boot-path diff could not be read"; exit 12; }
[ "$(sort <<<"$bp" | paste -sd,)" = "isolation/m2/client.mjs,isolation/m2/judge.mjs" ] || { say4 "REFUSING: the boot path differs in more than judge.mjs + client.mjs: $(paste -sd' ' <<<"$bp")"; exit 12; }
unrec_ok || { say4 "REFUSING: -unrecorded-releases is not the derived set of the installed releases (or R is not REL)"; exit 12; }
# the ids guestd will log for -legacy-isolation-release, in the flag's order (derived, as guestd derives them)
LEGIDS=$(for f in ${LEGREL_ARG//,/ }; do sha256sum < "${f#@}" | cut -c1-64; done | paste -sd' ')
[ "$LEGIDS" = "5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2 6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb" ] || { say4 "REFUSING: the legacy release files are not 0181bce3 (5c3561f9) + 6757d139 (6f14ce75)"; exit 12; }
# enclave-e3 A1: the scripted ADOPTION preflight (s4d-adoption-preflight.sh) for THIS binary and tree, under 2 hours old:
# a canary that fails adoption even once is stopped and scrubbed, which no rollback undoes
adopt_fresh() {   # $1 = max age in s. First line only; a plain 10-digit epoch; 0 <= age <= $1; each test on its own
  local ln ep now
  ln=$(head -1 $S4/adoption-check.txt 2>/dev/null || true)
  [[ "$ln" == "guestd $BINC sha256 $BSHA tree $IMG at "*": 3/3 canaries verify with the new tree's judge"* ]] || return 1
  ep=$(sed -n 's/.* epoch \([0-9]*\):.*/\1/p' <<<"$ln")
  [[ "$ep" =~ ^[1-9][0-9]{9}$ ]] || return 1
  now=$(date +%s)
  [ "$ep" -le "$now" ] || return 1
  [ $(( now - ep )) -le "$1" ] || return 1
}
adopt_fresh 7200 || { say4 "REFUSING: no adoption preflight for guestd $BINC / tree $IMG in the last 2 h (run s8-adoption-preflight.sh)"; exit 12; }
# enclave-d1: the RELAY must be ahead of guestd. Before guestd builds guests from the new tree, the relay's predictor
# must predict AND admit the new release for every canary (a guest on an unpredicted release gets no certificate from the
# 4c gate, and no release): /v1/expected-guest lists an image under release $REL with releaseAdmitted true
for cid in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
  eg=$(curl -sS --max-time 60 "https://api.enclave.host/v1/expected-guest?id=$cid" || true)
  python3 -c "import json,sys; r=json.loads(sys.argv[1]); sys.exit(0 if any(i.get('release')==sys.argv[2] and i.get('releaseAdmitted') is True for i in r.get('images',[])) else 1)" "$eg" "$REL" 2>/dev/null \
    || { say4 "REFUSING: the relay does not predict and admit release ${REL:0:12} for ${cid:0:10} (re-stage the predictor first)"; exit 13; }
done
tree_ok || { say4 "REFUSING: the installed tree"; exit 13; }
python3 "$T/isolation/m4/release-manifest.py" verify "$R" --expect "$REL" | grep -q "verified 15 files" || { say4 "REFUSING: $R does not verify"; exit 13; }
[ -f "$LEG/m4/build-app-guest.sh" ] && [ "$(git -C "$LEG/.." rev-parse HEAD)" = "$LEGC" ] || { say4 "REFUSING: the legacy tree is not $LEGC"; exit 13; }
reproduces || { say4 "REFUSING: 1d again (a host tool changed?)"; exit 14; }
lab_quiet || { say4 "REFUSING: this host is not quiet"; exit 15; }
avail=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
[ $(( avail - (65536 - 5376) )) -ge $FLOOR ] || { say4 "NO-GO: MemAvailable ${avail} MiB leaves < $FLOOR MiB at the full 64 GiB ceiling"; exit 16; }
awk 'BEGIN{f=1} /^some /{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){split($i,a,"="); f=(a[2]+0==0)?0:1}} END{exit f}' /proc/pressure/memory || { say4 "NO-GO: memory PSI avg60 not 0"; exit 16; }
check_guestd4 || { say4 "REFUSING: guestd is not at 65536/1600 with the 3 canaries on their current (e6) keys"; exit 17; }
for id in $CAN; do rstat_listed $id || { say4 "REFUSING: canary ${id:0:10} is not listed:true for the release"; exit 17; }; done
node_on_4cc || { say4 "REFUSING: the node is not 02f6e313 / f6cbd75a on launcher 578be084"; exit 17; }
noncanary_empty || { say4 "REFUSING: a non-canary deployment is (or may be) on metal-iso0: the auto-rollback would be refused"; exit 17; }
# the live ExecStart, exactly: the 4d line (the binary, these flags, nothing else); the auth-key's VALUE is never printed
python3 - "$U" "$OBIN" "$OT/isolation" "$LEG" "$FLOOR" <<'PY' || { say4 "REFUSING: ExecStart is not the live line (guestd.4e78ba80, iso-b63c2def, no per-release flags)"; exit 18; }
import sys,shlex
p,b,ot,leg,floor=sys.argv[1:]; ex=[l for l in open(p).read().split("\n") if l.startswith("ExecStart=")]
assert len(ex)==1; a=shlex.split(ex[0][len("ExecStart="):]); assert a[0]==b, a[0]
rest=a[1:]; assert rest.count("-release")==1; rest.remove("-release")      # the one boolean flag
kv=dict(zip(rest[0::2],rest[1::2])); assert len(rest)%2==0 and len(kv)==len(rest)//2
want={"-isolation":ot,"-root":"/home/steven/enclave-prod/guestd-root","-listen":"127.0.0.1:8095","-data-listen":"127.0.0.1:8096",
 "-gateway":"https://trustless-gateway.link","-guest-mem-mib":"65536","-guest-cpus":"16","-legacy-isolation":leg,
 "-instance-prefix":"gd","-guest-host-floor-mib":floor}
assert set(kv)==set(want)|{"-auth-key"}, sorted(kv)
assert all(kv[k]==v for k,v in want.items()) and kv["-auth-key"].startswith("/")
PY
# enclave-e3: the adoption preflight AGAIN, now: wasmtime, node or go changing inside the 2 h would make every canary
# fail adoption, and a canary that fails is scrubbed (no rollback undoes it)
"$S4/s8-adoption-preflight.sh" "$BINC" "$BSHA" || { say4 "REFUSING: the adoption preflight fails now"; exit 18; }
adopt_fresh 300 || { say4 "REFUSING: the adoption preflight just run left no fresh record"; exit 18; }
# vsock 9443/9444: the live guestd holds them since 4d, so there is no bind-probe; the restart hands them to the new
# process, and the journal's "attested release ON" line (a failed listen is fatal) proves the new one holds them
UNITS_BEFORE=$(units) || { say4 "REFUSING: the m2-gd* units are unreadable or not the 3 running canaries"; exit 19; }
# ---- the change: the ONE ExecStart line, atomically
TOK=$EV/secret/8t-rollback-token; TOKV=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
( umask 077; echo "$TOKV" > "$TOK" ) || { say4 "REFUSING: cannot write the rollback token"; exit 19; }
cp -p "$U" "$BAK"; chmod 600 "$BAK"
# FROM_APPLY: the preflight above verified the 3 canaries alone (on their current (e6) keys) and an empty non-canary set seconds
# before; the rollback skips its gate, which needs a READABLE guestd (the one thing a failed switch may not have)
fail() {
  set +e; trap '' TERM INT
  say4 "8T CHECK FAILED: $* -> rolling back to the guestd.4e78ba80 / iso-b63c2def unit"
  FROM_APPLY="$TOKV" FROM_APPLY_WHY="8t apply at $T0: $*" "$S4/s8t-rollback.sh"; local rc=$?
  if [ $rc = 0 ]; then exit 20; fi
  say4 "ROLLBACK FAILED rc=$rc: the switched unit may still be live; ESCALATE to enclave-87 (backup $BAK, token $TOK)"; exit 24
}
T0="before the restart"
trap 'fail "terminated (TERM/INT) after the change began"' TERM INT
python3 - "$U" "$OT/isolation" "$T/isolation" "$OBIN" "$NBIN" "$ISOREL_ARG" "$LEGREL_ARG" "$UNREC" <<'PY' || { if cmp -s "$U" "$BAK"; then mv "$BAK" "$BAK.unused-$(date -u +%Y%m%dT%H%M%SZ)"; rm -f "$TOK"; say4 "8T: the unit edit failed and the unit is unchanged: nothing restarted"; exit 21; fi; fail "the unit edit"; }
import sys,os,shlex
p,old,new,ob,nb,isorel,legrel,unrec=sys.argv[1:]; lines=open(p).read().split("\n"); i=[n for n,l in enumerate(lines) if l.startswith("ExecStart=")][0]
a=shlex.split(lines[i][len("ExecStart="):]); assert a[0]==ob; a[0]=nb     # the binary: guestd.4e78ba80 -> guestd.0c087de8
k=a.index("-isolation"); assert a[k+1]==old; a[k+1]=new                  # the tree: iso-b63c2def -> iso-0c087de8
assert not any(f in a for f in ("-isolation-release","-legacy-isolation-release","-unrecorded-releases"))
a+=["-isolation-release",isorel,"-legacy-isolation-release",legrel,"-unrecorded-releases",unrec]   # the per-release naming
lines[i]="ExecStart="+" ".join(a)   # every argument is a plain path/flag/number: no quoting needed (asserted)
assert all(shlex.quote(x)==x for x in a)
open(p+".new","w").write("\n".join(lines)); os.replace(p+".new",p)
PY
date +%s > ~/enclave-bench/fl-20260926/state/s8-switched-epoch || fail "writing the S8 epoch (the unit is edited: rolling back)"   # the first-launch check: a guest created after this must be 5db18199 (bf)
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "8T: daemon-reload + restart (guestd.4e78ba80 -> guestd.${NBINC:0:8}, -isolation ${OT##*/} -> ${T##*/}, + the per-release naming flags; all else unchanged)"
systemctl --user daemon-reload || fail "daemon-reload"
systemctl --user restart enclave-guestd.service || fail "restart"
X=$(systemctl --user show enclave-guestd.service -p ExecStart --value) || fail "ExecStart unreadable after the restart"
for s in "path=$NBIN ;" " -isolation $T/isolation " " -release " " -legacy-isolation $LEG " " -guest-host-floor-mib $FLOOR " " -guest-mem-mib 65536 -guest-cpus 16 " \
         " -isolation-release $ISOREL_ARG " " -legacy-isolation-release $LEGREL_ARG " " -unrecorded-releases $UNREC"; do
  echo "$X" | grep -Fq -- "$s" || fail "ExecStart lacks '$s'"
done
# enclave-e3 A2: Restart=on-failure would re-run adoption every 10 s; fail AT ONCE on a restart, or on a guest the new
# guestd dropped or stopped, instead of waiting out the 300 s
watch4d() {
  local end=$(( $(date +%s) + 300 )) nr
  while :; do
    nr=$(systemctl --user show enclave-guestd.service -p NRestarts --value 2>/dev/null) || return 2
    [ "$nr" = 0 ] || { say4 "8T: guestd restarted ($nr)"; return 2; }
    journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > "$J" 2>/dev/null || true
    grep -qE "not adopted, ended|stopped [0-9]+ guest unit" "$J" && { say4 "8T: the new guestd dropped or stopped a guest"; return 2; }
    check_guestd4 >/dev/null && return 0
    [ $(date +%s) -ge $end ] && return 1
    sleep 5
  done
}
watch4d || fail "guestd did not come back at 65536/1600 with the 3 same canaries (same keys), or restarted, or dropped a guest"
# /health: release ON with the legacy image; config/secrets/egress STAY off (the supervisor's claim gate is unchanged);
# the floor is 16384 and MemAvailable leaves room for the smallest guest above it; nothing is starting
python3 - $ST/.guestd.json $FLOOR <<'PY' || fail "/health supports or pool.host"
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
         "attested release ON: tickets on vsock 9444, egress on vsock 9443" \
         "per-release W^X: this tree's guests are named [$REL]; the legacy tree's [$LEGIDS]; unrecorded adoptions [${UNREC//,/ }]"; do
  grep -qF "$l" $J || fail "the journal lacks: $l"
done
! grep -qE "not adopted, ended|stopped [0-9]+ guest unit" $J || fail "the journal shows a guest dropped or stopped"
# the NEW judge's word on each re-adopted canary (its workdir's verify.txt, rewritten by the adoption): attested, and the
# f7888d86 legacy self-test accepted as runtime W^X UNMEASURED (named by -unrecorded-releases). Evidence for enclave-87,
# and a check: an adoption that said anything else would have come from a judge that is not the one reviewed
GIDS=$(python3 -c "import json; print(' '.join(v['id'] for v in json.load(open('$ST/.guestd.json'))[1]['body']['vms']))") || fail "guestd's /vms unreadable for the evidence"
[ "$(wc -w <<<"$GIDS")" = 3 ] || fail "guestd's /vms does not list exactly the 3 canaries for the evidence"
for g in $GIDS; do
  vt=$PROD/guestd-root/$g/verify.txt
  [ "$vt" -nt "$BAK" ] && grep -q '^VERDICT attested' "$vt" && grep -qx 'RESULT wx_coverage=runtime-unmeasured' "$vt" \
    || fail "canary $g: its adoption verify.txt is not fresh, attested, wx_coverage=runtime-unmeasured"
  say4 "8T evidence: $g re-adopted by the new judge: $(grep -m1 '^VERDICT ' "$vt" | cut -c1-60); $(grep -x 'RESULT wx_coverage=.*' "$vt")"
done
UA=$(units) || fail "the m2-gd* units are unreadable after the restart"; [ "$UA" = "$UNITS_BEFORE" ] || fail "the m2-gd* units changed (FATAL diff)"
wait_for 120 public_ok4 || fail "the canaries do not serve on their current (e6) keys"
avail64() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 else 1)"; }
wait_for 180 avail64 || fail "the supervisor's availability changed (64 GiB / 16, free 0.7 expected)"
node_on_4cc || fail "the node CVM's attested measurement, overlay or launcher moved"
relay_row_ok || fail "the relay does not list metal-iso0 serving and eligible"
rm -f "$TOK"; trap - TERM INT
say4 "8T APPLIED and checked (restart at $T0): guestd.${NBINC:0:8}, -isolation ${T##*/} (release ${REL:0:8}), per-release naming on; the 3 canaries re-adopted on f7888d86. Next: the 10-min gate, then each canary's owner restart onto 5db18199 (e7); rollback = s8t-rollback.sh"
