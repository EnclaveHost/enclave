#!/bin/bash
# Install the KVM-planes kernel on warden-host as an EXTRA, NON-DEFAULT boot entry (PLAN.md section 13,
# step 3). Needs root. Nothing this script writes replaces anything the machine currently boots from.
#
# Why a subdirectory instead of /boot/vmlinuz-linux-planes: /etc/grub.d/10_linux globs `/boot/vmlinuz-*`
# and reverse-version-sorts what it finds, and GRUB_DEFAULT is 0. A kernel named vmlinuz-linux-planes
# could therefore sort AHEAD of vmlinuz-linux and silently become the default entry -- the one thing
# step 3 must not do. Files under /boot/planes/ are invisible to that glob, and the menu entry is added
# by /etc/grub.d/42_planes, which runs after every generated entry, so entry 0 stays the Arch kernel.
#
# The command line is taken from /etc/default/grub verbatim, because this machine needs all of it:
# rd.luks.name= and root= to unlock and find an encrypted root, and usbcore.autosuspend=-1 because the
# only real NIC here is USB ethernet (r8152) -- lose that and the machine comes back with no network.
#
# usage:  sudo ./install-planes-kernel.sh install
#         sudo ./install-planes-kernel.sh uninstall     remove the entry, the files and the module tree
#         ./install-planes-kernel.sh check              read-only: what is present now (no root needed)
#
# After `install`, reboot and pick "Linux (KVM planes...)" from the GRUB menu ONCE -- it is not the
# default, so a power cycle alone returns you to the normal kernel. Then run isolation/m3/m3b-verify.sh.
set -euo pipefail
KIT=${KIT:-/home/steven/.cache/enclave-isolation}
SRC=$KIT/planeskit/linux
NV=$KIT/nvbuild
DEST=/boot/planes
GRUBD=/etc/grub.d/42_planes
action=${1:-check}

[ -r "$SRC/include/config/kernel.release" ] || { echo "no built kernel at $SRC"; exit 1; }
KREL=$(cat "$SRC/include/config/kernel.release")
MODS=/usr/lib/modules/$KREL

say() { printf '\n== %s\n' "$*"; }
need_root() { [ "$(id -u)" = 0 ] || { echo "$action needs root: re-run with sudo"; exit 1; }; }

# A failed install must leave NOTHING bootable and nothing half-written. The module tree is kept on
# purpose: it is inert without a boot entry, it is what `uninstall` removes, and a rebuild reuses it.
installing=0
on_exit() {
  rc=$?
  [ "$rc" = 0 ] && return 0
  [ "$installing" = 1 ] || return 0
  echo
  echo "FAILED (exit $rc). Removing what this run wrote, so nothing is half-installed:"
  rm -rfv "$DEST" "$GRUBD" 2>/dev/null | sed 's/^/  /'
  [ -e /boot/grub/grub.cfg ] && ! grep -q planes /boot/grub/grub.cfg \
    && echo "  /boot/grub/grub.cfg has no planes entry, so nothing can boot it"
  echo "  the module tree at $MODS is left in place (inert without a boot entry; 'uninstall' removes it)"
}
trap on_exit EXIT

case "$action" in
check)
  say "built kernel"
  echo "  release      $KREL"
  echo "  bzImage      $(stat -c '%s bytes, %y' "$SRC/arch/x86/boot/bzImage" 2>/dev/null || echo MISSING)"
  echo "  nvidia .ko   $(ls "$NV"/*.ko 2>/dev/null | wc -l) built$([ -e "$NV/nvidia.ko" ] && echo ", vermagic $(modinfo -F vermagic "$NV/nvidia.ko" 2>/dev/null | tr -d '\n')")"
  say "what is installed"
  echo "  module tree  $([ -d "$MODS" ] && echo "$MODS present" || echo "not installed")"
  echo "  kernel       $([ -e "$DEST/vmlinuz" ] && echo "$DEST/vmlinuz present" || echo "not installed")"
  echo "  initramfs    $([ -e "$DEST/initramfs.img" ] && echo "$DEST/initramfs.img present" || echo "not installed")"
  echo "  grub entry   $([ -e "$GRUBD" ] && echo "$GRUBD present" || echo "not installed")"
  say "what must not change"
  echo "  default      GRUB_DEFAULT=$(sed -n 's/^GRUB_DEFAULT=//p' /etc/default/grub) (entry 0, generated for /boot/vmlinuz-linux)"
  echo "  /boot free   $(df -h /boot | awk 'NR==2{print $4}')"
  echo "  running      $(uname -r)"
  ;;

install)
  need_root
  installing=1
  # Refuse to run if the pieces are not all there, rather than half-installing.
  [ -e "$SRC/arch/x86/boot/bzImage" ] || { echo "no bzImage in $SRC"; exit 1; }
  [ -e "$NV/nvidia.ko" ] || { echo "no built NVIDIA modules in $NV -- build them first, or there is no CUDA on this kernel"; exit 1; }
  got=$(modinfo -F vermagic "$NV/nvidia.ko" | awk '{print $1}')
  [ "$got" = "$KREL" ] || { echo "the NVIDIA modules are for '$got', not '$KREL': rebuild them against $SRC"; exit 1; }
  free_kb=$(df -Pk /boot | awk 'NR==2{print $4}')
  [ "$free_kb" -gt 262144 ] || { echo "/boot has only $((free_kb/1024)) MiB free; want 256 MiB (the initramfs here is ~130 MB)"; exit 1; }

  say "1. kernel modules -> $MODS"
  make -C "$SRC" INSTALL_MOD_STRIP=1 modules_install

  say "2. the NVIDIA modules, so the GPUs work on this kernel too"
  # Into updates/dkms/, where this machine already keeps them, so depmod prefers them exactly as it does
  # now. Stripped for the same reason the kernel's own modules are (step 1 passes INSTALL_MOD_STRIP):
  # nvidia.ko is 158 MB with debug info, the initramfs has to fit in a 1 GB ESP, and mkinitcpio's `kms`
  # hook pulls the DRM driver in. --strip-debug drops .BTF and debug sections only; the module still loads.
  install -d "$MODS/updates/dkms"
  for ko in "$NV"/nvidia*.ko; do
    install -m644 "$ko" "$MODS/updates/dkms/$(basename "$ko")"
    strip --strip-debug "$MODS/updates/dkms/$(basename "$ko")"
  done
  ls -la "$MODS/updates/dkms/" | awk 'NR>1{printf "  %10d  %s\n", $5, $9}'
  depmod -a "$KREL"
  # If this is wrong the machine boots without CUDA, which is the thing the other sessions need.
  modinfo -k "$KREL" nvidia > /dev/null && echo "  depmod resolves nvidia for $KREL"

  say "3. can the configured initramfs hooks actually be satisfied by this kernel?"
  # Derived from the hooks in /etc/mkinitcpio.conf rather than guessed: each hook's `add_module` names,
  # minus the ones marked optional with a trailing '?'. Resolved with `modinfo -k`, which is how
  # mkinitcpio itself resolves them, so built-ins and crypto aliases (crypto-lzo -> lzo) count as present.
  # This check exists because a MISSING one is fatal but only announced in the middle of mkinitcpio, after
  # the kernel has already been copied into /boot: CONFIG_DM_INTEGRITY was unset, sd-encrypt requires
  # dm-integrity unconditionally, and the build died with a half-written initramfs.
  # shellcheck disable=SC1091
  hooks=$(. /etc/mkinitcpio.conf; echo "${HOOKS[@]}")
  missing=""
  for h in $hooks; do
    hf=/usr/lib/initcpio/install/$h
    [ -r "$hf" ] || continue
    for m in $(grep -h 'add_module' "$hf" | grep -oE "'[^']+'" | tr -d "'" | grep -v '?$' | grep -v '[$]'); do
      if modinfo -k "$KREL" "$m" > /dev/null 2>&1; then
        printf '  %-16s %s: ok\n' "$h" "$m"
      else
        printf '  %-16s %s: MISSING\n' "$h" "$m"
        missing="$missing $m"
      fi
    done
  done
  if [ -n "$missing" ]; then
    cat <<EOF

This kernel cannot satisfy the hooks this machine's initramfs is built from. Missing:$missing

Enable each one in $SRC/.config and rebuild, e.g. for dm-integrity:
    ./scripts/config --file $SRC/.config --module DM_INTEGRITY
    make -C $SRC olddefconfig && make -C $SRC -j\$(nproc) modules
then rebuild the NVIDIA modules if the vermagic changed, and run this script again.
EOF
    exit 1
  fi

  say "4. kernel and initramfs -> $DEST (NOT /boot/vmlinuz-*, see the header)"
  install -Dm644 "$SRC/arch/x86/boot/bzImage" "$DEST/vmlinuz"
  # -k takes the IMAGE, not the version: mkinitcpio then reads the release out of it, instead of warning
  # "Could not find kernel image for version ..." because there is no /boot/vmlinuz-$KREL by design.
  # autodetect scans the RUNNING machine, which is what we want: the same hardware has to come back.
  mkinitcpio -k "$DEST/vmlinuz" -g "$DEST/initramfs.img"
  echo "  initramfs $(stat -c%s "$DEST/initramfs.img") bytes; /boot now $(df -h /boot | awk 'NR==2{print $4}') free"
  # Size is a poor test: the aborted build produced a plausible-looking 16.8 MB image. Ask instead
  # whether the three things this machine needs to REACH a login are in there: unlock the LUKS root,
  # see the NVMe it is on, and accept a typed passphrase. The GPUs are deliberately not checked here -
  # nvidia loads later from the module tree, and stage A of m3b-verify.sh is what proves it.
  for want in 'dm-crypt|dm_crypt' 'nvme' 'hid'; do
    n=$(lsinitcpio "$DEST/initramfs.img" | grep -cE "($want)" || true)
    [ "$n" -gt 0 ] && printf '  initramfs contains %-16s (%s matches)\n' "$want" "$n" \
      || { echo "  the initramfs has nothing matching '$want'; refusing to install it"; exit 1; }
  done
  [ "$(df -Pk /boot | awk 'NR==2{print $4}')" -gt 20480 ] || { echo "/boot is nearly full after this"; exit 1; }

  say "5. a menu entry, after every generated one, leaving entry 0 alone"
  esp=$(findmnt -no UUID /boot)
  # shellcheck disable=SC1090
  cmdline="$(. /etc/default/grub; echo "$GRUB_CMDLINE_LINUX $GRUB_CMDLINE_LINUX_DEFAULT")"
  echo "  cmdline: $cmdline"
  cat > "$GRUBD" <<EOF
#!/bin/sh
# Added by isolation/m3/install-planes-kernel.sh. Extra entry for the KVM-planes kernel ($KREL).
# It is deliberately LAST so GRUB_DEFAULT=0 keeps selecting the normal Arch kernel: booting this is
# always a deliberate choice at the menu, and a power cycle returns to the default.
cat <<ENTRY
menuentry 'Linux (KVM planes $KREL) -- NOT the default, for the VMPL boundary test' --class arch --class gnu-linux --id planes-$KREL {
	insmod part_gpt
	insmod fat
	search --no-floppy --fs-uuid --set=root $esp
	echo 'Loading the KVM-planes kernel ...'
	linux /planes/vmlinuz $cmdline
	initrd /planes/initramfs.img
}
ENTRY
EOF
  chmod 755 "$GRUBD"

  say "6. regenerate the menu, then CHECK the default did not move"
  grub-mkconfig -o /boot/grub/grub.cfg
  first=$(grep -m1 "^menuentry" /boot/grub/grub.cfg | sed "s/.*'\([^']*\)'.*/\1/")
  echo "  entry 0 is now: $first"
  case "$first" in
    *planes*) echo "  REFUSING TO LEAVE IT LIKE THIS: the planes kernel became the default."; exit 1 ;;
    *) echo "  good: entry 0 is unchanged, the planes entry is an explicit choice" ;;
  esac
  grep -c "^menuentry\|submenu" /boot/grub/grub.cfg | sed 's/^/  menu entries: /'
  grep -q "planes-$KREL" /boot/grub/grub.cfg && echo "  the planes entry is present"

  cat <<EOF

Installed. Nothing that existed was replaced.

To use it: reboot, and at the GRUB menu pick
    Linux (KVM planes $KREL) -- NOT the default, for the VMPL boundary test
then, once logged in:
    isolation/m3/m3b-verify.sh ~/m3b $KREL

m3b-verify.sh checks the health of the machine FIRST (GPUs, default route, DNS, sshd, and whether QEMU is
granted a plane) and tells you to roll back rather than continuing if any of that fails. Rolling back is
just: reboot and let the default entry take it, or pick the normal Arch kernel.

Be at the machine for this boot. There is no out-of-band console here: /dev/ipmi0 exists but ipmitool is
not installed, and the command line carries no console=, so if the kernel does not bring up networking
the only way in is the keyboard.
EOF
  ;;

uninstall)
  need_root
  installing=1
  say "removing the entry, the files and the module tree for $KREL"
  rm -f "$GRUBD"
  rm -rf "$DEST"
  rm -rf "$MODS"
  grub-mkconfig -o /boot/grub/grub.cfg
  grep -q "planes-$KREL" /boot/grub/grub.cfg && { echo "the entry is STILL in grub.cfg"; exit 1; }
  echo "gone. /boot/vmlinuz-linux and its initramfs were never touched."
  ;;

*) echo "usage: $0 install|uninstall|check"; exit 2 ;;
esac
