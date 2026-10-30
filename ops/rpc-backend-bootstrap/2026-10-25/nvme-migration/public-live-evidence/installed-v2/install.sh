#!/bin/bash
# Staged by migrate_nvme.py (enclave-rpc-nvme-migration/v1). ROOT REVIEWS FIRST. Run as uid 1000 (the user unit owner), never as root.
# Backs up the current v1 files, installs the staged v2 files, daemon-reloads and runs `provision_vm.py verify`.
# It never starts, stops or enables any unit and never touches a disk image.
set -euo pipefail
umask 077
STAGE=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-migration-stage/staged-final
STATE=/home/steven/.local/state/enclave-rpc-production
VM_UNIT=enclave-rpc-production-vm.service
GUARD_UNIT=enclave-rpc-production-guard.service
UNITDIR=/home/steven/.config/systemd/user
BK="$STATE/backup-c1b3d9e63fc0"
[ "$(id -u)" = 1000 ] || { echo "run as uid 1000"; exit 1; }
for u in "$VM_UNIT" "$GUARD_UNIT"; do
  s=$(systemctl --user show -p ActiveState --value "$u"); p=$(systemctl --user show -p MainPID --value "$u")
  case "$s" in inactive|failed) ;; *) echo "$u is $s: stop the VM first"; exit 1;; esac
  [ "$p" = 0 ] || { echo "$u MainPID $p"; exit 1; }
done
(cd "$STAGE" && sha256sum -c --quiet SHA256SUMS)
echo "ecbe7b65452b592742eb72f622bf9ea0dd52d51c825085e933f32a68d2f5f3ed  $STATE/manifest.json" | sha256sum -c --quiet -
echo "184e816cbfdaa0c880af75afa8aa5ada1d5193c0c9413ab070cebab71167a519  $STATE/provision_vm.py" | sha256sum -c --quiet -
echo "abe7744c07221413ba03218ba7d2320d6014dbd38ff38224ff9f39ad2f20e8be  $UNITDIR/$VM_UNIT" | sha256sum -c --quiet -
[ ! -e "$UNITDIR/$GUARD_UNIT" ] || { echo "$UNITDIR/$GUARD_UNIT already exists"; exit 1; }
for f in /vm/enclave-volumes/rpc-production/os.qcow2 /vm/enclave-volumes/rpc-production/l1-origin.qcow2; do [ -f "$f" ] || { echo "missing $f"; exit 1; }; done
mkdir -m 0700 "$BK"
cp -a "$STATE/manifest.json" "$STATE/provision_vm.py" "$BK/"
cp -a "$UNITDIR/$VM_UNIT" "$BK/$VM_UNIT"
(cd "$BK" && sha256sum manifest.json provision_vm.py "$VM_UNIT" > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$STAGE/provision_vm.py" "$STATE/.provision_vm.py.new" && mv -f "$STATE/.provision_vm.py.new" "$STATE/provision_vm.py"
install -m 0600 "$STAGE/manifest.json" "$STATE/.manifest.json.new" && mv -f "$STATE/.manifest.json.new" "$STATE/manifest.json"
install -m 0644 "$STAGE/$VM_UNIT" "$UNITDIR/.$VM_UNIT.new" && mv -f "$UNITDIR/.$VM_UNIT.new" "$UNITDIR/$VM_UNIT"
install -m 0644 "$STAGE/$GUARD_UNIT" "$UNITDIR/$GUARD_UNIT"
cmp "$STAGE/provision_vm.py" "$STATE/provision_vm.py"; cmp "$STAGE/manifest.json" "$STATE/manifest.json"
cmp "$STAGE/$VM_UNIT" "$UNITDIR/$VM_UNIT"; cmp "$STAGE/$GUARD_UNIT" "$UNITDIR/$GUARD_UNIT"
systemctl --user daemon-reload
if ! /usr/bin/python3 -I "$STATE/provision_vm.py" verify > "$BK/verify-after-install.json"; then
  echo "verify FAILED after install: run $STAGE/rollback.sh"; exit 1
fi
echo "installed v2 (backup $BK). Start only after review: systemctl --user start $VM_UNIT (pulls $GUARD_UNIT)"
