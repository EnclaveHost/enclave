# upgrade-common.sh - sourced by 30/40 only: ONE controller step in a transient system unit (final recipe §C1/§C2).
# run_step <version> <controller subcommand> <target sha> <expected current/running sha before> <expected dbVersion before>
run_step() {
  local n=$1 cmd=$2 to=$3 from=$4 vfrom=$5 unit="enclave-indexd-migrate-$1-$MRID" f rc=0
  r4_passed
  pin "$C/vm-state.sh" "$H_VMSTATE"
  ls "$OUT"/*."$n".STARTED >/dev/null 2>&1 && die "step v$n was already started in this window ($OUT): never re-run it; use final recipe §R"

  say "gate: source state v$vfrom on $from, quiet; VM copies of controller/profile/target pinned"
  f=$(ev "$n.pre-state.out")
  vm 120 'sudo bash -s' < "$C/vm-state.sh" > "$f" || die "vm-state.sh failed"
  kv "$f" current="$from" currentSha="$from" runningExeSha="$from" dbVersion="$vfrom" unit.ActiveState=active unit.SubState=running \
     'containerTimeout~.*GNU coreutils.*' fsync=on 'synchronous_commit~on|local|remote_apply' scratchDatabases= controllerSessions= \
     toolSessions= 'lockHeld~no.*' fencedAccounts? unit.NRestarts? || die "source state not as required: nothing started"
  f=$(ev "$n.vm-pins.out")
  vm 60 "echo ctl=\$(sudo sha256sum $CTL | cut -c1-64); echo prof=\$(sudo sha256sum $PROF | cut -c1-64); echo target=\$(sudo sha256sum /opt/enclave-indexd/releases/$to/indexd | cut -c1-64)" > "$f"
  kv "$f" ctl="$H_CTL" prof="$H_PROFILE" target="$to" || die "VM copies differ from the pins: nothing started"

  say "v$n: $cmd --sha256 $to (unit $unit; RuntimeMaxSec 3600; a dropped SSH does not stop it)"
  date -u +%FT%TZ > "$(ev "$n.STARTED")"
  vm 3700 "sudo systemd-run --unit=$unit --collect --wait --quiet --property=RuntimeMaxSec=3600 --property=TimeoutStopSec=300 --property=KillMode=mixed /usr/bin/python3 $CTL --profile $PROF $cmd --sha256 $to --confirm $cmd" || rc=$?
  echo "rc=$rc"
  f=$(ev "$n.journal.out")
  vm 60 "sudo journalctl -u $unit -o cat --no-pager" > "$f" || true
  cat "$f"
  if [ "$rc" = 255 ] || [ "$rc" = 124 ]; then
    die "SSH ended (rc $rc); the unit may still run. Read: systemctl status $unit; journalctl -u $unit. Do NOT re-run"
  fi
  [ "$rc" = 0 ] || die "v$n step rc $rc: read the journal above, then final recipe (exit 1 'backup verification failed before the switch' -> its resume; else §R). Do NOT re-run"
  jl "$f" "r.get('ok') is True and r.get('dbVersion') == $n and r.get('backupVerified') is True and r.get('digestPreserved') is True and r.get('fenceRouteStatusUnauthenticated') == 401" ||
    die "v$n result not the required one: final recipe §R"
  python3 -B -c 'import json,re,sys
r = json.loads([l for l in open(sys.argv[1]) if l.lstrip().startswith("{")][-1])
assert re.fullmatch(r"/var/lib/enclave-indexd/migration-backups/[0-9]{8}T[0-9]{6}Z", r["backup"]), r["backup"]
print("backup=" + r["backup"])' "$f" > "$(ev "$n.DONE")"
  cat "$OUT"/*."$n".DONE
  say "v$n DONE. Next: 50-postcheck.sh $n now, and again >= 10 minutes later (the soak)"
}
