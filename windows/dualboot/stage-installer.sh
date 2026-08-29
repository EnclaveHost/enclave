#!/usr/bin/env bash
# stage-installer.sh -- put the Windows 11 installer on an internal partition.
#
#   sudo ./stage-installer.sh                 # dry run
#   sudo ./stage-installer.sh --apply
#
# No USB needed.  Carves a 12 GiB FAT32 partition out of the very END of the
# free space on nvme0n1, unpacks the ISO into it (install.wim split into
# .swm parts so it fits FAT32's 4 GiB file limit), and adds a UEFI boot entry.
# Windows then installs into the free space in front of it.
set -euo pipefail

DISK=/dev/nvme0n1
ISO="${ISO:-/home/steven/Downloads/Win11_25H2_English_x64_v2.iso}"
SIZE_GIB=12
LABEL=WINSETUP
BASIC_DATA=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7
APPLY=0
WORK=/var/tmp/winstage

[ "${1:-}" = --apply ] && APPLY=1

die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
[ -f "$ISO" ] || die "ISO not found: $ISO"
for t in mkfs.vfat wimlib-imagex 7z sfdisk efibootmgr; do
  command -v "$t" >/dev/null || die "missing tool: $t  (pacman -S wimlib dosfstools p7zip)"
done

SECT=512
ALIGN=2048
DISK_SECTORS=$(cat /sys/class/block/$(basename $DISK)/size)
LAST_USABLE=$((DISK_SECTORS - 34))

# Largest free region on the disk.
read -r FREE_START FREE_SECTORS < <(sfdisk -F "$DISK" | awk '/^ *[0-9]/{print $1, $3}' | sort -k2 -n | tail -1)
[ -n "${FREE_START:-}" ] || die "no free space on $DISK -- run shrink-vm.sh first"

WANT=$((SIZE_GIB * 1024 * 1024 * 1024 / SECT))
[ "$FREE_SECTORS" -gt $((WANT + 64 * 1024 * 1024 * 1024 / SECT)) ] \
  || die "free region is only $((FREE_SECTORS*SECT/1024/1024/1024)) GiB; need the installer plus room for Windows"

# Sit at the far end so Windows gets a contiguous block in front of it.
STAGE_START=$(( (LAST_USABLE - WANT + 1) / ALIGN * ALIGN ))
STAGE_SECTORS=$((LAST_USABLE - STAGE_START + 1))
WIN_SECTORS=$((STAGE_START - FREE_START))

h() { numfmt --to=iec --suffix=B "$(($1 * SECT))"; }

echo "free region      sectors $FREE_START .. $((FREE_START+FREE_SECTORS-1))   $(h $FREE_SECTORS)"
echo "installer part   sectors $STAGE_START .. $LAST_USABLE   $(h $STAGE_SECTORS)   FAT32 '$LABEL'"
echo "left for Windows sectors $FREE_START .. $((STAGE_START-1))   $(h $WIN_SECTORS)"
echo "iso              $ISO"
echo

if [ "$APPLY" != 1 ]; then
  echo "DRY RUN -- nothing changed.  Re-run with --apply."
  exit 0
fi

echo "==> creating partition"
echo "start=$STAGE_START, size=$STAGE_SECTORS, type=$BASIC_DATA, name=\"$LABEL\"" \
  | sfdisk --append --no-reread --no-tell-kernel "$DISK"
partx -a "$DISK" 2>/dev/null || partprobe "$DISK" || true
sleep 2

PARTNUM=$(sfdisk -l -o Device,Start "$DISK" | awk -v s="$STAGE_START" '$2==s{print $1}' | grep -o '[0-9]*$')
[ -n "$PARTNUM" ] || die "could not find the partition just created"
PARTDEV="${DISK}p${PARTNUM}"
[ -b "$PARTDEV" ] || die "$PARTDEV did not appear"
echo "    created $PARTDEV"

echo "==> formatting FAT32"
mkfs.vfat -F 32 -n "$LABEL" "$PARTDEV"

MNT=$(mktemp -d)
mount "$PARTDEV" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT

echo "==> unpacking ISO (everything except sources/install.wim)"
7z x -y -o"$MNT" "$ISO" -x'!sources/install.wim' >/dev/null
echo "==> extracting install.wim to $WORK"
mkdir -p "$WORK"
7z e -y -o"$WORK" "$ISO" sources/install.wim >/dev/null
echo "==> images in install.wim:"
wimlib-imagex info "$WORK/install.wim" | sed -n 's/^/    /p' | head -40
echo "==> splitting into 3800 MiB .swm parts"
wimlib-imagex split "$WORK/install.wim" "$MNT/sources/install.swm" 3800
rm -f "$WORK/install.wim"
sync
ls -la "$MNT/sources/" | grep -i swm
df -h "$MNT" | tail -1
umount "$MNT"; rmdir "$MNT"; trap - EXIT

echo "==> adding a UEFI boot entry (temporarily first in BootOrder)"
efibootmgr -c -d "$DISK" -p "$PARTNUM" -L "Windows Setup" -l '\EFI\BOOT\BOOTX64.EFI'
echo
efibootmgr
echo
cat <<'MSG'
Ready.  Reboot and pick "Windows Setup" (it is first in the boot order now).

In Setup:
  * When it says this PC cannot run Windows 11:  Shift+F10  ->  regedit
      HKEY_LOCAL_MACHINE\SYSTEM\Setup\LabConfig     (create the LabConfig key)
        BypassTPMCheck         DWORD  1
        BypassSecureBootCheck  DWORD  1
      close regedit, go back, retry.
  * At the disk screen pick the large UNALLOCATED region on Drive 1.
    Do NOT touch:  the 3.4 TB partition on Drive 1 (that is /vm),
                   anything at all on Drive 0 (that is Arch),
                   the 12 GB WINSETUP partition (that is this installer).
    Setup will create System/MSR/Primary/Recovery inside the unallocated space.
MSG
