#!/usr/bin/env bash
# grub-dualboot.sh -- GRUB boots first and offers Windows; Arch stays default.
#
#   sudo ./grub-dualboot.sh
#
# Two separate things have to be right, and only one of them is GRUB:
#
#   1. UEFI BootOrder.  Windows Setup put "Windows Boot Manager" first, so the
#      firmware goes straight there and never reaches GRUB -- which is why
#      booting Arch currently means a trip through the firmware boot menu.
#      This puts Arch (GRUB) back at the head.
#
#   2. GRUB menu entries.  Written explicitly rather than via os-prober: the
#      UUIDs are known and fixed, so an explicit chainloader entry is
#      deterministic and cannot produce duplicates or odd labels.
set -euo pipefail

ESP_UUID=F1F1-8675          # nvme1n1p1 -- the Arch ESP, also holds bootmgfw.efi
SETUP_UUID=B889-C8A2        # nvme0n1p5 -- the WINSETUP installer partition
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

# Sanity: refuse to write entries pointing at loaders that are not there.
[ -f /boot/EFI/Microsoft/Boot/bootmgfw.efi ] || die "bootmgfw.efi not found on the ESP"

echo "==> writing /etc/grub.d/40_custom"
cat > /etc/grub.d/40_custom <<'CUSTOM'
#!/bin/sh
exec tail -n +3 $0
# This file provides an easy way to add custom menu entries.  Simply type the
# menu entries you want to add after this comment.  Be careful not to change
# the 'exec tail' line above.

menuentry 'Windows 11' --class windows --class os $menuentry_id_option 'windows-bootmgr' {
	insmod part_gpt
	insmod fat
	insmod chain
	search --no-floppy --fs-uuid --set=root ESP_UUID_PLACEHOLDER
	chainloader /EFI/Microsoft/Boot/bootmgfw.efi
}

menuentry 'Windows Setup (installer partition)' --class windows --class os $menuentry_id_option 'windows-setup' {
	insmod part_gpt
	insmod fat
	insmod chain
	search --no-floppy --fs-uuid --set=root SETUP_UUID_PLACEHOLDER
	chainloader /EFI/BOOT/BOOTX64.EFI
}
CUSTOM
sed -i "s/ESP_UUID_PLACEHOLDER/$ESP_UUID/; s/SETUP_UUID_PLACEHOLDER/$SETUP_UUID/" /etc/grub.d/40_custom
chmod +x /etc/grub.d/40_custom

echo "==> Arch stays the default entry, menu stays visible"
sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=0/' /etc/default/grub
sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=5/' /etc/default/grub
sed -i 's/^GRUB_TIMEOUT_STYLE=.*/GRUB_TIMEOUT_STYLE=menu/' /etc/default/grub

echo "==> regenerating grub.cfg"
grub-mkconfig -o /boot/grub/grub.cfg 2>&1 | sed 's/^/    /'

echo
echo "==> menu entries now:"
grep -n '^menuentry\|^submenu' /boot/grub/grub.cfg | sed 's/^/    /'

echo
echo "==> UEFI boot order"
BEFORE=$(efibootmgr)
printf '%s\n' "$BEFORE" | sed 's/^/    /'
ARCH=$(printf '%s\n' "$BEFORE" | sed -n 's/^Boot\([0-9A-F]\{4\}\)\*\? *Arch Linux.*/\1/p' | head -1)
[ -n "$ARCH" ] || die "could not find the Arch Linux boot entry"
ORDER=$(printf '%s\n' "$BEFORE" | sed -n 's/^BootOrder: //p')
REST=$(printf '%s' "$ORDER" | tr ',' '\n' | grep -v "^$ARCH$" | paste -sd,)
NEW="$ARCH${REST:+,$REST}"
echo
echo "    $ORDER  ->  $NEW"
efibootmgr -o "$NEW" >/dev/null
echo
efibootmgr | sed 's/^/    /'

cat <<'MSG'

Done.  The firmware now goes to GRUB, Arch is highlighted and boots after 5
seconds, and 'Windows 11' plus 'Windows Setup (installer partition)' are on the
menu below it.  No more firmware boot menu.

One thing to watch: Windows rewrites the UEFI boot order to put itself first
after some updates and after a repair.  If you ever land straight in Windows
again, re-run this script -- it is idempotent.
MSG
