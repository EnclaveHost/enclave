#!/bin/bash
# 50-postcheck.sh <27|28> - READ-ONLY post-checks after 30/40 (final recipe §C1 "Success"; ROOT ONLY; prepared, never
# run by its author). Run it right after the step and again >= 10 minutes later: the soak. 40 requires two v27 passes.
# Health is judged by direct indexd probes against the L7 baseline. The app smoke is root's to record; it never gates.
source "$(dirname "$0")/lib.sh"
n=${1:-}
case "$n" in 27) H=$H_FENCE ;; 28) H=$H_C2 ;; *) die "usage: MRID=... 50-postcheck.sh 27|28" ;; esac
pin "$C/vm-state.sh" "$H_VMSTATE"
marker "$n.DONE"
bk=$(sed -n 's/^backup=//p' "$OUT"/*."$n".DONE)
[[ "$bk" =~ ^/var/lib/enclave-indexd/migration-backups/[0-9]{8}T[0-9]{6}Z$ ]] || die "bad backup path in the $n.DONE evidence"
net=$(python3 -B -c 'import json,sys; print(json.loads(open(sys.argv[1]).read().splitlines()[-1])["network"])' "$(ls "$OUT"/*.20.baseline-readiness.json | head -1)")

say "readiness v$n against the step's verified backup manifest; network as in the baseline ($net)"
f=$(ev "50.$n.readiness.json")
vm 300 "$RC readiness --expect-version $n --expect-digest $bk/manifest.json" > "$f" || true
jl "$f" "r.get('ok') is True and r.get('adminState') == 200 and r.get('dbVersion') == $n and r.get('digestMatches') is True and r.get('fenceRoute') == 401 and r.get('network') == '$net'" ||
  die "indexd probe failed (a regression): final recipe §R/§B"

say "the step's verification record: exactly one scratch, dropped"
f=$(ev "50.$n.verify-record.json")
vm 60 "sudo python3 -c 'import glob,json,sys; rs=[json.load(open(p)) for p in sorted(glob.glob(sys.argv[1] + \"/verify-indexd_verify_*.json\"))]; print(json.dumps({\"n\": len(rs), \"states\": [r.get(\"scratchState\") for r in rs], \"cleanupOk\": [r.get(\"cleanupOk\") for r in rs], \"ok\": [r.get(\"ok\") for r in rs]}))' $bk" > "$f" || true
jl "$f" "r.get('n') == 1 and r['states'] == ['dropped'] and r['cleanupOk'] == [True] and r['ok'] == [True]" || die "verification record not 'dropped'/ok: read $bk on the VM"

say "state: release $H, schema v$n, quiet; no CAS enrolment"
f=$(ev "50.$n.vm-state.out")
vm 120 'sudo bash -s' < "$C/vm-state.sh" > "$f" || die "vm-state.sh failed"
extra=(fencedAccounts?); [ "$n" = 28 ] && extra=(fencedAccounts? casEnrolledAccounts=0)
kv "$f" current="$H" currentSha="$H" runningExeSha="$H" dbVersion="$n" unit.ActiveState=active unit.SubState=running \
   scratchDatabases= controllerSessions= toolSessions= 'lockHeld~no.*' "${extra[@]}" || die "state not as required after v$n"

say "unit restarts and warnings (soak: NRestarts must not change between passes)"
f=$(ev "50.$n.unit.out")
vm 60 'echo "NRestarts=$(systemctl show enclave-indexd -p NRestarts --value)"; echo "warnings30min=$(journalctl -u enclave-indexd --since -30min -p warning --no-pager -q | wc -l)"' > "$f"
cat "$f" "$OUT"/*.20.baseline-unit.out
nr=$(sed -n 's/^NRestarts=//p' "$f")
[[ "$nr" =~ ^[0-9]+$ ]] || die "NRestarts unreadable"
prev=$(ls "$OUT"/*.50."$n".PASS 2>/dev/null | head -1 || true)
[ -z "$prev" ] || grep -qx "NRestarts=$nr" "$prev" || die "NRestarts changed since the first v$n pass ($prev): a restart loop is a regression"
printf 'epoch=%s\nNRestarts=%s\n' "$(date +%s)" "$nr" > "$(ev "50.$n.PASS")"
say "v$n POST-CHECK PASS. Record root's app smoke result next to the baseline (it never gates)."
