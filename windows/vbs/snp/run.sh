#!/bin/sh
# The exact runs behind windows/vbs/snp/README.md. Unprivileged: the user needs the `kvm` group
# (/dev/kvm and /dev/sev are root:kvm 0660 on warden-host). Each run is a guest whose PID 1 is a
# static probe; it prints its findings and powers off.
set -e
cd "$(dirname "$0")"
OVMF=/usr/share/edk2-ovmf/x64/OVMF.4m.fd
M=/lib/modules/$(uname -r)/kernel
SNP="-machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1 \
 -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on \
 -object memory-backend-memfd,id=ram1,size=2G,share=true"
PLAIN="-machine q35,accel=kvm"
COMMON="-cpu host -smp 2 -m 2G -bios $OVMF -kernel /boot/vmlinuz-linux -nographic -no-reboot"
APPEND="console=ttyS0 rdinit=/init loglevel=4"

pack() {  # pack <src.c> <out.cpio.gz> <modules...>
  d=$(mktemp -d); gcc -static -O2 -o "$d/init" "$1"; shift; out=$1; shift
  for m in "$@"; do cp "$M/$m" "$d/"; done
  mkdir -p "$d/proc" "$d/sys" "$d/dev"
  (cd "$d" && ls | cpio -o -H newc 2>/dev/null | gzip) > "$out"; rm -rf "$d"
}
pack snpctl.c /tmp/snpctl.cpio.gz drivers/virt/coco/guest/tsm_report.ko.zst drivers/virt/coco/sev-guest/sev-guest.ko.zst
pack kvmtest.c /tmp/kvmtest.cpio.gz virt/lib/irqbypass.ko.zst drivers/crypto/ccp/ccp.ko.zst arch/x86/kvm/kvm.ko.zst arch/x86/kvm/kvm-amd.ko.zst

echo "== 1. SNP positive control";         qemu-system-x86_64 $SNP   $COMMON -initrd /tmp/snpctl.cpio.gz  -append "$APPEND" 2>&1 | grep '^CTL'
echo "== 2. same probe, no SNP";           qemu-system-x86_64 $PLAIN $COMMON -initrd /tmp/snpctl.cpio.gz  -append "$APPEND" 2>&1 | grep '^CTL'
echo "== 3. nested KVM inside SNP guest";  qemu-system-x86_64 $SNP   $COMMON -initrd /tmp/kvmtest.cpio.gz -append "$APPEND" 2>&1 | grep '^NEST'
echo "== 4. nested KVM inside plain guest";qemu-system-x86_64 $PLAIN $COMMON -initrd /tmp/kvmtest.cpio.gz -append "$APPEND" 2>&1 | grep '^NEST'
