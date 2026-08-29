#!/usr/bin/env bash
# write-usb.sh -- put the tested Windows guest image onto a USB disk.
#
#   sudo ./write-usb.sh /dev/sdX
#
# Refuses to run unless the target is USB-attached and NOT a mounted or
# LUKS-backing device, because the two NVMes in this box hold / and /vm.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMG="${IMG:-$HERE/run/win11.qcow2}"
DEV="${1:-}"

die() { echo "error: $*" >&2; exit 1; }
[ -n "$DEV" ] || die "usage: sudo $0 /dev/sdX"
[ -b "$DEV" ] || die "$DEV is not a block device"
[ -f "$IMG" ] || die "image not found: $IMG"
[ "$(id -u)" = 0 ] || die "must run as root (writing to a raw block device)"

NAME="$(basename "$DEV")"
TRAN="$(lsblk -ndo TRAN "$DEV" 2>/dev/null | head -1)"
[ "$TRAN" = usb ] || die "$DEV transport is '${TRAN:-unknown}', not usb. Refusing: the NVMe devices hold / and /vm."

# Refuse if this disk or any partition of it is mounted or is a LUKS holder.
if lsblk -nro MOUNTPOINT "$DEV" | grep -q .; then
  die "$DEV has a mounted partition. Unmount it first, and be certain it is the right disk."
fi
if lsblk -nro FSTYPE "$DEV" | grep -qi crypto_LUKS; then
  die "$DEV contains a LUKS volume. Refusing."
fi

echo "target:"
lsblk -o NAME,SIZE,TRAN,MODEL,SERIAL,FSTYPE,LABEL "$DEV"
echo
echo "source: $IMG"
qemu-img info "$IMG" | sed -n 's/^/  /p' | head -4
echo
read -rp "This ERASES $DEV completely. Type the device name to confirm: " ok
[ "$ok" = "$DEV" ] || die "confirmation did not match; nothing written"

echo "writing (this takes a few minutes over USB) ..."
qemu-img convert -p -O raw "$IMG" "$DEV"
sync
echo
echo "done. Partition table now on $DEV:"
partprobe "$DEV" 2>/dev/null || true
lsblk -o NAME,SIZE,FSTYPE,LABEL "$DEV"
echo
echo "Next: reboot, pick this disk in the firmware boot menu, then in Windows:"
echo '  reg add "HKLM\System\CurrentControlSet\Control\Hypervisor" /v EnableHardwareIsolation /t REG_DWORD /d 1 /f'
echo '  Restart-Computer'
echo '  Get-VMHost | Select-Object SnpStatus, TdxStatus, GuestIsolationTypes'
echo '  C:\enclave\Test-EnclaveHost.ps1 -Attempt -IsolationType SNP'
