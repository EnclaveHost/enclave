#!/bin/bash
# 00-gate.sh - READ-ONLY gate before the window's first change (ROOT ONLY; prepared, never run by its author).
# Run AFTER root's fresh backup B2' is complete AND its off-host archive integrity check has passed (root's evidence).
# Changes nothing on the VM except ONE unnamed, auto-removed container (step 5: no mount, no network, no pull) that
# proves `docker run --init` works before PostgreSQL is ever stopped.
# Writes <stamp>.00.PASS only if every check holds. It starts nothing else.
source "$(dirname "$0")/lib.sh"

say "1. local pins of every input the later steps use"
pin "$V/frozen/replicactl.r5-production.restorefix.bounds.py" "$H_CTL"
pin "$C/live-primary.profile.proposed.json" "$H_PROFILE"
pin "$C/vm-state.sh" "$H_VMSTATE"
pin "$B/fence-enclave-a/indexd" "$H_FENCE"; pin "$B/c2-enclave-a/indexd" "$H_C2"
pin work/indexd-replica-rollout/systemd/primary-upgrade.conf "$H_DROPIN"
pin "$PF/vm-preflight.sh" "$H_PREFLIGHT"; pin "$PF/evaluate-preflight.py" "$H_EVALUATE"
pin "$I/enclave-indexd-postgres.service.candidate" "$H_UNIT_NEW"; pin "$I/enclave-indexd-postgres.service.rollback-e0a45f51" "$H_UNIT_OLD"
pin "$I/pg-init-probe.sh" "$H_PROBE"; pin "$I/compare.py" "$H_COMPARE"
while IFS=: read -r f h; do pin "$M/$f" "$h"; done <<< "$MIGRATION_FILES"
echo "local pins ok"

say "2. r4 preflight (read-only, bounded 300 s on the VM): must be READY_FOR_FRESH_BACKUP"
f=$(ev 00.preflight.out)
vm 340 'sudo bash -s' < "$PF/vm-preflight.sh" > "$f" || die "preflight capture failed (ssh or script); see $f"
python3 -B "$PF/evaluate-preflight.py" "$f" | tee "$(ev 00.preflight.eval.json)" || die "preflight is not READY_FOR_FRESH_BACKUP"

say "3. state probe (vm-state.sh): v26 stock, serving, quiet"
f=$(ev 00.vm-state.out)
vm 120 'sudo bash -s' < "$C/vm-state.sh" > "$f" || die "vm-state.sh failed; see $f"
kv "$f" current=NONE unit.ActiveState=active unit.SubState=running runningExeSha="$H_STOCK" dbVersion=26 \
   'containerTimeout~.*GNU coreutils.*' fsync=on 'synchronous_commit~on|local|remote_apply' \
   scratchDatabases= controllerSessions= toolSessions= 'lockHeld~no.*' || die "state is not the v26 stock baseline"

say "4. PostgreSQL unit and docker-init (read-only)"
f=$(ev 00.init-gate.out)
vm 60 'U=/etc/systemd/system/enclave-indexd-postgres.service
  echo "unitSha=$(sudo sha256sum "$U" | cut -c1-64)"
  echo "unitStat=$(sudo stat -c "%a %U:%G" "$U")"
  echo "dropIns=$(systemctl show enclave-indexd-postgres -p DropInPaths --value)"
  echo "pgActive=$(systemctl show enclave-indexd-postgres -p ActiveState --value)"
  echo "initBinary=$(sudo docker info --format "{{.InitBinary}}")"
  echo "components=$(sudo docker version --format "{{range .Server.Components}}{{.Name}} {{end}}")"' > "$f" || die "init gate read failed; see $f"
kv "$f" unitSha="$H_UNIT_OLD" 'unitStat=644 root:root' dropIns= pgActive=active 'initBinary~.+' 'components~.*\bdocker-init\b.*' ||
  die "the PostgreSQL unit or docker-init is not as expected: do not run 10-init-swap.sh"

say "5. --init works on this daemon (ONE unnamed --rm container from the present image; no mount/network/pull)"
pid1=$(vm 90 "sudo timeout 60 docker run --rm --init --pull never --network none --entrypoint cat $IMAGE /proc/1/comm") || pid1="(failed rc $?)"
echo "pid1=$pid1" | tee "$(ev 00.init-probe.out)"
[ "$pid1" = docker-init ] || die "docker run --init did not give docker-init as PID 1"

date -u +%FT%TZ > "$(ev 00.PASS)"
say "GATE PASS ($OUT). Next, after reading it: 10-init-swap.sh (or skip step I: 20-layout.sh checks state itself)"
