#!/usr/bin/env bash
# fix-usb-boot.sh -- diagnose, then make the USB storage stack boot-critical so
# a normal Windows install can boot from USB.
#
# WHY: Windows ships USBSTOR/UASPStor/usbxhci/USBHUB3 as demand-start (Start=3).
# The boot loader therefore cannot reach a USB-attached system disk and bugchecks
# with INACCESSIBLE_BOOT_DEVICE -- monitors flash, machine reboots, no dump.
# Windows To Go existed to change exactly this; Microsoft removed the feature in
# 1903 but the underlying registry change still works, and it is what Rufus's
# Windows To Go mode does.
#
# Backs the SYSTEM hive up before touching it. Read-only diagnosis first.
set -euo pipefail
DEV="${1:-/dev/sda3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MNT=$(mktemp -d)
cleanup() { mountpoint -q "$MNT" && umount "$MNT" || true; rmdir "$MNT" 2>/dev/null || true; }
trap cleanup EXIT

[ "$(id -u)" -eq 0 ] || { echo "run with sudo"; exit 1; }
command -v python3 >/dev/null || { echo "python3 required"; exit 1; }

modprobe ntfs3 2>/dev/null || true
mount -t ntfs3 -o rw "$DEV" "$MNT" || { echo "could not mount $DEV read-write"; exit 1; }
echo "mounted $DEV at $MNT"

HIVE="$MNT/Windows/System32/config/SYSTEM"
[ -f "$HIVE" ] || { echo "SYSTEM hive not found -- wrong partition?"; exit 1; }

echo
echo "=== diagnosis ==="
shopt -s nullglob
DUMPS=("$MNT"/Windows/Minidump/*.dmp "$MNT"/Windows/MEMORY.DMP)
if [ ${#DUMPS[@]} -eq 0 ]; then
  echo "  no crash dump -- consistent with a boot-critical driver failure"
  echo "  (INACCESSIBLE_BOOT_DEVICE bugchecks before a dump can be written)"
else
  for d in "${DUMPS[@]}"; do echo "  dump: $(basename "$d") $(stat -c%s "$d") bytes"; done
  echo "  a dump exists -- Windows got further than the storage stack;"
  echo "  the fix below may not be the right one. Inspect before rebooting."
fi
[ -d "$MNT/enclave" ] && echo "  C:\\enclave present: $(ls "$MNT/enclave" | tr '\n' ' ')"

# Which control set is current? (CurrentControlSet is a runtime alias only.)
CS=$(python3 "$HERE/hivepatch.py" "$HIVE" get 'Select' 'Current' 2>/dev/null | grep -oE '= [0-9]+' | tr -d '= ' || true)
CS=${CS:-1}
CSET=$(printf 'ControlSet%03d' "$CS")
echo
echo "=== current control set: $CSET ==="

echo
echo "=== USB storage services, before (Start: 0=boot 1=system 3=demand 4=off) ==="
SVCS=(usbxhci USBHUB3 usbhub UASPStor USBSTOR usbccgp EhStorClass stornvme storahci)
for s in "${SVCS[@]}"; do
  python3 "$HERE/hivepatch.py" "$HIVE" get "$CSET\\Services\\$s" Start 2>/dev/null || true
done

BAK="$HIVE.enclave-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$HIVE" "$BAK"
echo
echo "hive backed up to $(basename "$BAK")"

echo
echo "=== making the USB storage stack boot-critical ==="
for s in usbxhci USBHUB3 usbhub UASPStor USBSTOR; do
  python3 "$HERE/hivepatch.py" "$HIVE" set "$CSET\\Services\\$s" Start 0 2>/dev/null || true
done

echo
echo "=== after ==="
for s in "${SVCS[@]}"; do
  python3 "$HERE/hivepatch.py" "$HIVE" get "$CSET\\Services\\$s" Start 2>/dev/null || true
done

sync
echo
echo "done. Reboot and select the SSK drive in the firmware boot menu."
echo "If it still fails, restore with:  cp $(basename "$BAK") SYSTEM  (in $MNT/Windows/System32/config)"
