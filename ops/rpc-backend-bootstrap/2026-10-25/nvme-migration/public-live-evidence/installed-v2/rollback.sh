#!/bin/bash
# Restores the v1 files backed up by install.sh. Run as uid 1000, VM and guard stopped. The HDD images were never
# modified by the migration, but any chain progress made while running on the NVMe copies is NOT on the HDD copies.
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
  case "$s" in inactive|failed) ;; *) echo "$u is $s: stop it first"; exit 1;; esac
  [ "$p" = 0 ] || { echo "$u MainPID $p"; exit 1; }
done
(cd "$BK" && sha256sum -c --quiet SHA256SUMS)
install -m 0500 "$BK/provision_vm.py" "$STATE/.provision_vm.py.new" && mv -f "$STATE/.provision_vm.py.new" "$STATE/provision_vm.py"
install -m 0600 "$BK/manifest.json" "$STATE/.manifest.json.new" && mv -f "$STATE/.manifest.json.new" "$STATE/manifest.json"
install -m 0644 "$BK/$VM_UNIT" "$UNITDIR/.$VM_UNIT.new" && mv -f "$UNITDIR/.$VM_UNIT.new" "$UNITDIR/$VM_UNIT"
if [ -e "$UNITDIR/$GUARD_UNIT" ]; then
  cmp "$STAGE/$GUARD_UNIT" "$UNITDIR/$GUARD_UNIT" && rm -f "$UNITDIR/$GUARD_UNIT"
fi
rm -f "$STATE/guard-status.json" "$STATE/guard-mode.json"
systemctl --user daemon-reload
/usr/bin/python3 -I "$STATE/provision_vm.py" verify > "$BK/verify-after-rollback.json"
echo "rolled back to the v1 HDD manifest; the NVMe copies are left in place for root to keep or delete"
