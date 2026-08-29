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
#
# Every step is resumable: re-running picks up whatever is not done yet and
# never re-creates a partition that already exists.
#
# Note on style: this runs under 'set -o pipefail', so no pipeline here may
# close early.  'cmd | head -n', 'awk {...; exit}' and 'cmd | grep -q' all
# send SIGPIPE upstream, which pipefail turns into a failing pipeline -- that
# either kills the script under 'set -e' or silently inverts an 'if'.  Output
# is captured into a variable first and filtered afterwards instead.
set -euo pipefail

DISK=/dev/nvme0n1
ISO="${ISO:-/home/steven/Downloads/Win11_25H2_English_x64_v2.iso}"
SIZE_GIB=12
LABEL=WINSETUP
BASIC_DATA=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7
ENTRY="Windows Setup"
APPLY=0
WORK=/var/tmp/winstage

[ "${1:-}" = --apply ] && APPLY=1

die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"
[ -f "$ISO" ] || die "ISO not found: $ISO"
for t in mkfs.vfat wimlib-imagex 7z sfdisk efibootmgr blkid; do
  command -v "$t" >/dev/null || die "missing tool: $t  (pacman -S wimlib dosfstools p7zip)"
done

SECT=512
ALIGN=2048
DISK_SECTORS=$(cat "/sys/class/block/$(basename $DISK)/size")
LAST_USABLE=$((DISK_SECTORS - 34))
h() { numfmt --to=iec "$(($1 * SECT))"; }

free_region() {   # -> "start end sectors" for the largest gap, empty if none
  local t
  t=$(sfdisk -F "$DISK" 2>/dev/null || true)
  printf '%s\n' "$t" | awk '/^ *[0-9]/{print $1, $2, $3}' | sort -k3 -n | tail -1
}

# ---- is the partition already there from an earlier run? ------------------
PARTDEV=$(blkid -t LABEL="$LABEL" -o device 2>/dev/null | grep "^$DISK" || true)
NEED_CREATE=1

if [ -n "$PARTDEV" ]; then
  PARTNUM="${PARTDEV##*p}"
  NEED_CREATE=0
  echo "installer part   $PARTDEV exists already (label $LABEL) -- resuming"
else
  read -r FREE_START FREE_END FREE_SECTORS <<<"$(free_region)" || true
  [ -n "${FREE_START:-}" ] || die "no free space on $DISK -- run shrink-vm.sh first"
  WANT=$((SIZE_GIB * 1024 * 1024 * 1024 / SECT))
  [ "$FREE_SECTORS" -gt $((WANT + 64 * 1024 * 1024 * 1024 / SECT)) ] \
    || die "free region is only $(h "$FREE_SECTORS"); need the installer plus room for Windows"
  # Sit at the far end so Windows gets a contiguous block in front of it.
  STAGE_START=$(( (LAST_USABLE - WANT + 1) / ALIGN * ALIGN ))
  STAGE_SECTORS=$((LAST_USABLE - STAGE_START + 1))
  echo "free region      sectors $FREE_START .. $FREE_END   $(h "$FREE_SECTORS")"
  echo "installer part   sectors $STAGE_START .. $LAST_USABLE   $(h "$STAGE_SECTORS")   FAT32 '$LABEL'"
fi

read -r WS WE WN <<<"$(free_region)" || true
[ -n "${WS:-}" ] && echo "left for Windows sectors $WS .. $WE   $(h "$WN")"
echo "iso              $ISO"
echo

if [ "$APPLY" != 1 ]; then
  echo "DRY RUN -- nothing changed.  Re-run with --apply."
  exit 0
fi

if [ "$NEED_CREATE" = 1 ]; then
  echo "==> creating partition"
  echo "start=$STAGE_START, size=$STAGE_SECTORS, type=$BASIC_DATA, name=\"$LABEL\"" \
    | sfdisk --append --no-reread --no-tell-kernel "$DISK"

  # Read the number back out of the on-disk table.  p1 is held by dm-crypt, so
  # the kernel will not re-read the whole table -- add only the new partition.
  TABLE=$(sfdisk -l -o Device,Start "$DISK")
  PARTNUM=$(printf '%s\n' "$TABLE" | awk -v s="$STAGE_START" '$2==s{print $1}' | grep -o '[0-9]*$')
  [ -n "$PARTNUM" ] || die "could not find the partition just written to the table"
  PARTDEV="${DISK}p${PARTNUM}"
  partx -a --nr "$PARTNUM" "$DISK" 2>/dev/null || true
  udevadm settle 2>/dev/null || true
  for _ in $(seq 20); do [ -b "$PARTDEV" ] && break; sleep 0.5; done
  [ -b "$PARTDEV" ] || die "$PARTDEV did not appear"
  echo "    created $PARTDEV"

  echo "==> formatting FAT32"
  mkfs.vfat -F 32 -n "$LABEL" "$PARTDEV"
fi

MNT=$(mktemp -d)
mount "$PARTDEV" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT

if [ -f "$MNT/setup.exe" ] && [ -f "$MNT/sources/boot.wim" ] && [ -f "$MNT/efi/boot/bootx64.efi" ]; then
  echo "==> ISO already unpacked, skipping"
else
  echo "==> unpacking ISO (everything except sources/install.wim)"
  7z x -y -o"$MNT" "$ISO" -x'!sources/install.wim' >/dev/null
fi

LISTING=$(7z l "$ISO" 2>/dev/null || true)
ISO_WIM_BYTES=$(printf '%s\n' "$LISTING" | awk '/sources\/install\.wim/{print $4}')
if [ -s "$WORK/install.wim" ] && [ "$(stat -c %s "$WORK/install.wim")" = "$ISO_WIM_BYTES" ]; then
  echo "==> install.wim already extracted to $WORK, skipping"
else
  echo "==> extracting install.wim to $WORK"
  mkdir -p "$WORK"
  7z e -y -o"$WORK" "$ISO" sources/install.wim >/dev/null
fi

echo "==> editions in install.wim:"
WIMINFO=$(wimlib-imagex info "$WORK/install.wim")
printf '%s\n' "$WIMINFO" \
  | awk '/^Index:/{i=$2} /^Name:/{sub(/^Name:[ \t]+/,""); printf "      %2s  %s\n", i, $0}'

if [ -f "$MNT/sources/install.swm" ]; then
  echo "==> already split, skipping"
else
  echo "==> splitting into 3800 MiB .swm parts (a few minutes)"
  wimlib-imagex split "$WORK/install.wim" "$MNT/sources/install.swm" 3800
  sync
fi
ls -la "$MNT/sources/" | grep -i swm || true
df -h "$MNT" | tail -1
umount "$MNT"; rmdir "$MNT"; trap - EXIT
rm -f "$WORK/install.wim"; rmdir "$WORK" 2>/dev/null || true

BOOTENTRIES=$(efibootmgr || true)
if [[ "$BOOTENTRIES" == *"$ENTRY"* ]]; then
  echo "==> UEFI entry '$ENTRY' exists already"
else
  echo "==> adding a UEFI boot entry (temporarily first in BootOrder)"
  efibootmgr -c -d "$DISK" -p "$PARTNUM" -L "$ENTRY" -l '\EFI\BOOT\BOOTX64.EFI' >/dev/null
fi
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
