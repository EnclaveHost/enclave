#!/usr/bin/env bash
# 4c-c-b: point metal/config.iso.json's dist at the RELEASE-CAPABLE image (dist-iso-f6cbd75a) AND add isolation.release=true
# (5d's gsup opt-in), in ONE node CVM restart; nothing else changes. The new supervisor (the same 8 files as 4c) resumes
# the canaries by ADOPTING their running guests (a running guest is adopted, legacy or release; only a STARTING release
# guest is pumped). With the opt-in, a deployment the RELAY lists (after 4b) launches as a release guest on its next
# (re)spawn; none relaunches here. Run DETACHED via s4cc-run.sh b, after 4c-c-a.
# cc-v2: the SAME restart also moves the node's WorkingDirectory to the launcher-fix worktree (a user drop-in, see
# lib4cc.sh), because the launcher at 0181bce3 drops isolation.release (run 1, 22:45Z, rolled back). Needs
# s4ccl-worktree.sh first.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh
trap '' HUP PIPE
trap 'say "4c-c-b: terminated before any change"; exit 143' TERM INT
grep -qE '^0::/.*/s4ccb-apply-[0-9]{8}T[0-9]{6}Z\.service$' /proc/self/cgroup || { say "REFUSING: run 4c-c-b detached, through s4cc-run.sh b"; exit 2; }
check_prediction4c || exit 2
check_launcher || { say "REFUSING: the launcher-fix worktree is not ready (s4ccl-worktree.sh)"; exit 2; }
[ ! -e "$DI" ] || { say "REFUSING: $DI exists (a drop-in is already there)"; exit 2; }
[ "$(unit_wd)" = "$OLDW" ] && node_runs_from "$OLDW" "$OLDLS" || { say "REFUSING: the node does not run the 0181bce3 launcher from iso-03be27d6 now"; exit 2; }
[ "$(python3 -c "import json;print(json.load(open('$C'))['cpus'])")" = 4 ] || { say "REFUSING: config cpus is not 4 (the prediction is for 4 vCPUs)"; exit 2; }
[ "$(python3 -c "import json;print(json.load(open('$C'))['dist'])")" = "$OLDD" ] || { say "REFUSING: dist is not the 4c image"; exit 2; }
python3 -c "import json,sys; c=json.load(open('$C')); i=c.get('isolation'); sys.exit(0 if isinstance(i,dict) and 'release' not in i else 1)" || { say "REFUSING: config.iso.json has no isolation object, or isolation.release is already set"; exit 2; }
[ "$(allowlist)" = "METAL_ALLOWED_MEASUREMENTS=$ALLOW_NEW" ] || { say "REFUSING: the relay does not allowlist the 4c-c image (run 4c-c-a first)"; exit 3; }
[ -e "$CB4" ] && { say "REFUSING: $CB4 exists (4c-c-b already ran?)"; exit 4; }
read -r am ao <<<"$(node_attested)" || true; [ "${am:-}" = "$OLDM" ] && [[ "${ao:-}" == b3109929* ]] || { say "REFUSING: the node does not attest 8ab7a159 / b3109929 now"; exit 5; }
check_guestd pool64 || { say "REFUSING: guestd is not at 65536/1600 with the 3 S0 canaries"; exit 6; }
noncanary_empty || { say "REFUSING: a non-canary deployment is (or may be) on metal-iso0 (the auto-rollback would be refused)"; exit 6; }
avail_before || { say "REFUSING: the availability is not 4c's (64/16, free 0.7, the floor verdict)"; exit 7; }
wait_for 60 public_ok || { say "REFUSING: the canaries do not serve now"; exit 7; }
# the 4c supervisor's cert gate asks the relay for each canary's prediction: it must answer now (the relay slice)
ADMIT=79c5ecf24eb48a70e2bb20f4bca684b4d5e3c7700f9bf9d38735c19509898ce4 bash ~/enclave-bench/rs4-20260925/pkg/accept.sh > $S4C/4ccb-accept-before.txt 2>&1 || { say "REFUSING: the relay's expected-guest acceptance fails (4ccb-accept-before.txt)"; exit 8; }
# ---- the change: dist only, atomically; from here every failure rolls back with a one-time token
TOK=$EV/secret/4cc-rollback-token; TOKV=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
( umask 077; echo "$TOKV" > "$TOK" ) || { say "REFUSING: cannot write the rollback token"; exit 9; }
cp -p "$C" "$CB4"; chmod 600 "$CB4"
T0="before the restart"
fail() { set +e; trap '' TERM INT; say "4c-c-b CHECK FAILED: $* -> rolling back to dist-iso-b3109929 without the release opt-in, launcher iso-03be27d6"; FROM_APPLY="$TOKV" FROM_APPLY_WHY="4c-c-b at $T0: $*" "$S4C/s4ccb-rollback.sh"; local rc=$?; [ $rc = 0 ] && exit 20; say "ROLLBACK FAILED rc=$rc: ESCALATE to Codex (backup $CB4)"; exit 24; }
trap 'fail "terminated (TERM/INT) after the change began"' TERM INT
python3 - "$C" "$OLDD" "$NEWD" "$EV/secret/config.iso.json.new" <<'PY' || { if cmp -s "$C" "$CB4"; then mv "$CB4" "$CB4.unused-$(date -u +%Y%m%dT%H%M%SZ)"; rm -f "$TOK"; say "4c-c-b: the config edit failed and the config is unchanged: nothing restarted"; exit 21; fi; fail "the config edit"; }
import sys,os,json
p,old,new,tmp=sys.argv[1:]; a=json.load(open(p)); assert a["dist"]==old and "release" not in a["isolation"]
b=json.loads(json.dumps(a)); b["dist"]=new; b["isolation"]["release"]=True
# exactly two changes: dist, and the NEW key isolation.release = true; everything else (every other key and the rest of
# the isolation object) is equal
assert {k:v for k,v in a.items() if k not in ("dist","isolation")}=={k:v for k,v in b.items() if k not in ("dist","isolation")}
assert {k:v for k,v in b["isolation"].items() if k!="release"}==a["isolation"] and b["isolation"]["release"] is True
t=json.dumps(b,indent=2)+"\n"
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600); os.write(fd,t.encode()); os.close(fd); os.replace(tmp,p)   # same filesystem: atomic
PY
# the edited config as the LAUNCHER reads it (enclave-d1, retry check a): release a boolean true, dist the new image; a
# non-boolean release makes the fixed launcher exit, and under Restart=always that is a crash loop with the node down
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(c.isolation.release===true && c.dist===process.argv[2] ? 0 : 1)' "$C" "$NEWD" \
  || fail "the edited config is not what the launcher must read (isolation.release === true, dist f6cbd75a)"
# the launcher: a drop-in carrying WorkingDirectory only (systemd reads *.conf only, so the temporary name is inert)
mkdir -p "$DI" && printf '%s\n' "$DROP_BODY" > "$DI/.10-launcher.conf.new" && mv "$DI/.10-launcher.conf.new" "$DROP" || fail "writing the launcher drop-in"
systemctl --user daemon-reload || fail "daemon-reload"
[ "$(unit_wd)" = "$LW" ] || fail "the drop-in is not effective (WorkingDirectory is $(unit_wd))"
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say "4c-c-b: dist -> dist-iso-f6cbd75a + isolation.release=true, launcher -> $LW (${LAUNCH_C:0:8}); restarting enclave-metal-iso (the node CVM reboots)"
systemctl --user restart enclave-metal-iso.service || fail "restart"
wait_for 30 node_runs_from "$LW" "$LAUNCH_SHA" || fail "the node does not run the reviewed launcher from $LW"
attested_new() { [ "$(node_attested)" = "$NEWM $NEWC" ]; }
wait_for 600 attested_new || fail "the node never attested ${NEWM:0:12} with overlay f6cbd75a"
say "4c-c-b: the node ATTESTS ${NEWM:0:16} (raw report 0x90), overlay f6cbd75a, launcher ${LAUNCH_C:0:8} from $LW"
wait_for 120 relay_row_ok || fail "the relay does not list metal-iso0 serving and eligible"
wait_for 300 avail4c || fail "availability is not 64/16, free 0.7, with the floor verdict {16384, admitsSmallestGuest true}"
wait_for 300 public_ok || fail "the canaries do not serve with their S0 keys"
check_guestd pool64 || fail "guestd lost a canary or a key changed (a resume relaunched one?)"
journalctl --user -u enclave-metal-iso.service --since "$T0" --no-pager -o cat > $S4C/4ccb-node-journal.txt 2>&1 || true
# adopted = supervisor.js "adopted guest"; ANY release counts (enclave-d1): "[claim] released 0x", a failed "[claim] release
# 0x... attempt", "shutdown: releasing" (releaseClaimsOnShutdown), releaseLease
na=$(grep -c 'adopted guest' $S4C/4ccb-node-journal.txt || true)
nr=$(grep -ciE 'released [0-9x]|\[claim\] release 0x|shutdown: releasing|releaseLease' $S4C/4ccb-node-journal.txt || true)
say "4c-c-b: node journal: $na adopted-guest lines, $nr release lines"
[ "$na" -ge 3 ] && [ "$nr" = 0 ] || fail "the resumes did not adopt the 3 canaries (adopted $na, released $nr)"
# both halves, in order (enclave-d1, retry check b), each anchored to its OWN line (the two lines share the words
# "attested release OPTED IN", so an unanchored grep would take the launcher's for gsup's): the HOST launcher forwarded
# release:true into fw_cfg, then gsup (in the guest) read it and passed ISOLATION_RELEASE to the supervisor
grep -qE '^\[enclave-metal\] isolation snp-guest-per-app: attested release OPTED IN' $S4C/4ccb-node-journal.txt || fail "the HOST launcher did not report the attested-release opt-in"
grep -qE '^\[gsup\] per-app isolation tier snp-guest-per-app: .*attested release OPTED IN' $S4C/4ccb-node-journal.txt || fail "gsup (the guest) did not report the attested-release opt-in"
node_runs_from "$LW" "$LAUNCH_SHA" || fail "the node no longer runs the reviewed launcher from $LW (it restarted?)"
rm -f "$TOK"; trap - TERM INT
say "4c-c-b APPLIED and checked (restart at $T0). Next: observe.sh 4cc (the 10-min gate); rollback = s4ccb-rollback.sh, then s4cca-rollback.sh"
