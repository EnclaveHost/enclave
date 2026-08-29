#!/usr/bin/env bash
# grub-dualboot.sh -- add Windows to the GRUB menu, keep Arch as the default.
# Run this AFTER Windows is installed and has booted at least once.
#
#   sudo ./grub-dualboot.sh
set -euo pipefail
die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

echo "==> installing os-prober and ntfs-3g"
pacman -S --needed --noconfirm os-prober ntfs-3g

echo "==> enabling OS probing in /etc/default/grub"
if grep -q '^GRUB_DISABLE_OS_PROBER=' /etc/default/grub; then
  sed -i 's/^GRUB_DISABLE_OS_PROBER=.*/GRUB_DISABLE_OS_PROBER=false/' /etc/default/grub
else
  sed -i 's/^#GRUB_DISABLE_OS_PROBER=false/GRUB_DISABLE_OS_PROBER=false/' /etc/default/grub
fi
grep -q '^GRUB_DISABLE_OS_PROBER=false' /etc/default/grub \
  || echo 'GRUB_DISABLE_OS_PROBER=false' >> /etc/default/grub

# Arch stays the default entry and the menu stays visible.
sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=0/' /etc/default/grub
sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=5/' /etc/default/grub

echo "==> what os-prober sees:"
os-prober || true

echo "==> regenerating grub.cfg"
grub-mkconfig -o /boot/grub/grub.cfg

echo "==> menu entries now:"
grep -n "^menuentry\|^submenu" /boot/grub/grub.cfg

echo
echo "==> UEFI boot order: putting Arch (GRUB) first"
efibootmgr | sed -n 's/^/    /p'
ARCH=$(efibootmgr | awk '/Boot[0-9A-F]{4}\*? *Arch Linux/{print substr($1,5,4)}')
SETUP=$(efibootmgr | awk '/Windows Setup/{print substr($1,5,4)}')
[ -n "$SETUP" ] && { echo "    removing the temporary 'Windows Setup' entry Boot$SETUP"; efibootmgr -b "$SETUP" -B >/dev/null; }
if [ -n "$ARCH" ]; then
  REST=$(efibootmgr | awk '/^BootOrder:/{print $2}' | tr ',' '\n' | grep -v "^$ARCH$" | grep -v "^${SETUP:-zzzz}$" | paste -sd,)
  efibootmgr -o "$ARCH${REST:+,$REST}" >/dev/null
fi
echo
efibootmgr
echo
echo "Done.  GRUB comes up first, Arch is the highlighted default, and"
echo "'Windows Boot Manager' is on the menu below it."
