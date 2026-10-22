#!/bin/bash
# 11-init-rollback.sh - the narrow undo of step I ONLY: back to the exact old unit e0a45f51 (ROOT ONLY, root's decision;
# prepared, never run by its author).
# Run it when 10-init-swap.sh stopped after I3 or later, or when root decides to revert --init.
# - It stops indexd and PostgreSQL and requires a clean shutdown and no container.
# - It reinstalls the old unit and compares the result with THIS window's original BEFORE probe.
# - It never runs docker rm/volume rm, never kills anything, and never touches the data directory, postgres.env or
#   the image.
# - If PostgreSQL is still under the old unit (10 stopped before I4), the reinstall is a no-op and the result is
#   simply the old unit restarted.
source "$(dirname "$0")/lib.sh"
ls "$OUT"/*.10.before.out >/dev/null 2>&1 || die "no BEFORE probe in $OUT: step I never stopped PostgreSQL; if indexd is stopped, start it after review"
pin "$I/enclave-indexd-postgres.service.rollback-e0a45f51" "$H_UNIT_OLD"; pin "$I/pg-init-probe.sh" "$H_PROBE"; pin "$I/compare.py" "$H_COMPARE"

say "R1. stop indexd, then PostgreSQL; clean shutdown; no container"
vm 240 'sudo systemctl stop enclave-indexd' || die "systemctl stop enclave-indexd failed"
vm 200 'sudo systemctl stop enclave-indexd-postgres' || die "systemctl stop enclave-indexd-postgres failed"
f=$(ev 11.stopped.out)
vm 90 'echo "indexd=$(systemctl show enclave-indexd -p ActiveState --value)"; echo "pg=$(systemctl show enclave-indexd-postgres -p ActiveState --value)"
  echo "cleanShutdown=$(sudo journalctl -u enclave-indexd-postgres --since -5min --no-pager -o cat | grep -c "database system is shut down")"
  for i in $(seq 1 30); do n=$(sudo docker ps -a -q --filter "name=^/enclave-indexd-postgres$" | wc -l); [ "$n" = 0 ] && break; sleep 1; done
  echo "containers=$n"' > "$f" || true
kv "$f" indexd=inactive pg=inactive containers=0 cleanShutdown? ||
  die "not stopped or a container remains: inspect 'docker ps -a --filter name=enclave-indexd-postgres' yourself (an EXITED one: plain docker rm, never -f/-v)"

say "R2. reinstall the exact old unit (the copy staged in I1; else the identical local copy, staged exclusively)"
if ! vm 30 "sudo test -f $VD/old.service"; then
  vm 60 "sudo install -d -o root -g root -m 0700 $VD && sudo sh -c 'set -C; umask 077; cat > $VD/old.service'" < "$I/enclave-indexd-postgres.service.rollback-e0a45f51"
fi
f=$(ev 11.installed.out)
vm 90 "[ \"\$(sudo sha256sum $VD/old.service | cut -c1-64)\" = $H_UNIT_OLD ] &&
  sudo install -m 0644 -o root -g root $VD/old.service /etc/systemd/system/enclave-indexd-postgres.service && sudo systemctl daemon-reload &&
  echo unit=\$(sudo sha256sum /etc/systemd/system/enclave-indexd-postgres.service | cut -c1-64) &&
  echo reload=\$(systemctl show enclave-indexd-postgres -p NeedDaemonReload --value)" > "$f" || true
kv "$f" unit="$H_UNIT_OLD" reload=no || die "old unit not reinstalled: everything is STOPPED; inspect before anything else"

say "R3. start PostgreSQL; compare with the ORIGINAL BEFORE probe"
vm 60 'sudo systemctl start enclave-indexd-postgres' || true
f=$(ev 11.rollback.out)
vm 400 'sudo bash -s -- wait' < "$I/pg-init-probe.sh" > "$f" || true
python3 -B "$I/compare.py" "$OUT"/*.10.before.out "$f" --expect rollback | tee "$(ev 11.compare.txt)" ||
  die "rollback compare FAILED: indexd STOPPED. Read the evidence; B2' is the last resort (final recipe X/G5)"

say "R4. resume indexd"
vm 60 'sudo systemctl start enclave-indexd' || die "indexd start failed"
sleep 15
f=$(ev 11.vm-state.out)
vm 120 'sudo bash -s' < "$C/vm-state.sh" > "$f" || true
kv "$f" unit.ActiveState=active unit.SubState=running runningExeSha="$H_STOCK" dbVersion=26 scratchDatabases= controllerSessions= toolSessions= ||
  die "indexd not serving v26 after the rollback: read the journal"
date -u +%FT%TZ > "$(ev 11.ROLLED-BACK)"
say "STEP I ROLLED BACK: old unit e0a45f51, postgres PID 1, identity/digest equal to BEFORE"
