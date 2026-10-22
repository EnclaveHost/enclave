#!/bin/bash
# 10-init-swap.sh - step I of postgres-init-stage/RECIPE.md: the one-token --init swap of enclave-indexd-postgres
# (e0a45f51 -> 59b60ddd) in the quiesced window (ROOT ONLY; prepared, never run by its author).
# Preconditions:
# - root's B2' archive integrity check has passed;
# - 00-gate.sh PASSED in this window.
# indexd is down about 1-3 minutes. At the first failed check it STOPS and prints where things stand; it never
# removes, kills or rolls back by itself. The narrow undo of this step is 11-init-rollback.sh, run only by root's
# decision. Nothing here touches the data directory, the volume, postgres.env or the image.
source "$(dirname "$0")/lib.sh"
marker 00.PASS
pin "$I/enclave-indexd-postgres.service.candidate" "$H_UNIT_NEW"; pin "$I/pg-init-probe.sh" "$H_PROBE"; pin "$I/compare.py" "$H_COMPARE"
ls "$OUT"/*.10.before.out >/dev/null 2>&1 && die "a BEFORE probe of this window already exists: step I was started; read $OUT first"

say "I1. stage both units in $VD (exclusive)"
vm 60 "sudo install -d -o root -g root -m 0700 $VD" || die "cannot create $VD"
vm 60 "sudo sh -c 'set -C; umask 077; cat > $VD/new.service'" < "$I/enclave-indexd-postgres.service.candidate" || die "staging new.service failed (exists?)"
vm 60 "sudo sh -c 'set -C; cp -p /etc/systemd/system/enclave-indexd-postgres.service $VD/old.service'" || die "staging old.service failed"
f=$(ev 10.staged.out)
vm 60 "sudo sh -c 'echo new=\$(sha256sum $VD/new.service | cut -c1-64); echo old=\$(sha256sum $VD/old.service | cut -c1-64)'" > "$f"
kv "$f" new="$H_UNIT_NEW" old="$H_UNIT_OLD" || die "staged unit hashes differ; nothing stopped yet"

say "I2. stop indexd FIRST (it Requires the PostgreSQL unit), then the BEFORE probe"
vm 240 'sudo systemctl stop enclave-indexd' || die "systemctl stop enclave-indexd failed: read its state"
f=$(ev 10.indexd-stopped.out)
vm 60 'echo "active=$(systemctl show enclave-indexd -p ActiveState --value)"; echo "writers=$(pgrep -u enclave-indexd -x indexd | tr "\n" " ")"' > "$f"
kv "$f" active=inactive writers= || die "indexd is not stopped: PostgreSQL untouched; restart indexd yourself after review"
f=$(ev 10.before.out)
vm 300 'sudo bash -s' < "$I/pg-init-probe.sh" > "$f" || true
kv "$f" probe.complete=yes container.running=yes pid1.comm=postgres postmaster.pid=1 pg.otherClientSessions=0 db.version=26 digest.rc=0 ||
  die "BEFORE probe incomplete/unexpected. PostgreSQL untouched, indexd STOPPED: after review, 'sudo systemctl start enclave-indexd'"

say "I3. stop PostgreSQL cleanly; the old container must be gone"
vm 200 'sudo systemctl stop enclave-indexd-postgres' || die "systemctl stop enclave-indexd-postgres failed: read state; see 11-init-rollback.sh"
f=$(ev 10.pg-stopped.out)
vm 90 'echo "active=$(systemctl show enclave-indexd-postgres -p ActiveState --value)"; echo "result=$(systemctl show enclave-indexd-postgres -p Result --value)"
  echo "cleanShutdown=$(sudo journalctl -u enclave-indexd-postgres --since -5min --no-pager -o cat | grep -c "database system is shut down")"
  for i in $(seq 1 30); do n=$(sudo docker ps -a -q --filter "name=^/enclave-indexd-postgres$" | wc -l); [ "$n" = 0 ] && break; sleep 1; done
  echo "containers=$n"' > "$f"
kv "$f" active=inactive result=success 'cleanShutdown~[1-9][0-9]*' containers=0 ||
  die "not a clean stop or the container remains: unit NOT changed. Read RECIPE I3 / 11-init-rollback.sh (no automatic docker rm)"

say "I4. install the candidate unit, daemon-reload"
f=$(ev 10.installed.out)
vm 90 "sudo install -m 0644 -o root -g root $VD/new.service /etc/systemd/system/enclave-indexd-postgres.service && sudo systemctl daemon-reload &&
  echo unit=\$(sudo sha256sum /etc/systemd/system/enclave-indexd-postgres.service | cut -c1-64) &&
  echo reload=\$(systemctl show enclave-indexd-postgres -p NeedDaemonReload --value) &&
  echo init=\$(systemctl show enclave-indexd-postgres -p ExecStart --value | grep -c -- ' --init ')" > "$f" || true
kv "$f" unit="$H_UNIT_NEW" reload=no init=1 || die "candidate unit not cleanly installed: PostgreSQL is STOPPED; decide 11-init-rollback.sh"

say "I5. start PostgreSQL, wait ready, AFTER probe, compare"
vm 60 'sudo systemctl start enclave-indexd-postgres' || true
f=$(ev 10.after.out)
vm 400 'sudo bash -s -- wait' < "$I/pg-init-probe.sh" > "$f" || true
python3 -B "$I/compare.py" "$OUT"/*.10.before.out "$f" --expect init | tee "$(ev 10.compare.txt)" ||
  die "compare FAILED: indexd STOPPED, PostgreSQL under the new unit. Read the evidence; the undo is 11-init-rollback.sh"

say "I6. resume indexd; v26 stock serving again"
vm 60 'sudo systemctl start enclave-indexd' || die "indexd start failed: read its journal"
sleep 15
f=$(ev 10.vm-state.out)
vm 120 'sudo bash -s' < "$C/vm-state.sh" > "$f" || true
kv "$f" unit.ActiveState=active unit.SubState=running runningExeSha="$H_STOCK" dbVersion=26 'containerTimeout~.*GNU coreutils.*' \
   scratchDatabases= controllerSessions= toolSessions= unit.NRestarts? || die "indexd not serving v26 after the swap: read the journal before anything else"

date -u +%FT%TZ > "$(ev 10.PASS)"
say "STEP I PASS: PID 1 is docker-init; identity, schema v26 and digest unchanged. Next (after reading): 20-layout.sh"
