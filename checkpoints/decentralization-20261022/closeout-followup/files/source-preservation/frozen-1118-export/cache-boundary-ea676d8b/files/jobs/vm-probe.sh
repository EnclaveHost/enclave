#!/bin/bash
# READ-ONLY: can a throwaway QEMU guest run the host's own kernel (no host module load, no root)?
set -u
K=/boot/vmlinuz-linux; M=/lib/modules/$(uname -r)
echo "## uname"; uname -r
echo "## qemu"; command -v qemu-system-x86_64 && qemu-system-x86_64 --version | head -1
echo "## kvm"; ls -l /dev/kvm
echo "## kernel image readable"; ls -l /boot/ 2>&1 | grep -E 'vmlinuz|initramfs' ; [ -r "$K" ] && echo "$K readable" || echo "$K NOT readable"
echo "## modules on disk"; for m in dm-cache dm-cache-smq dm-persistent-data dm-bio-prison dm-bufio dm-crypt loop 9p 9pnet 9pnet_virtio netfs virtio_scsi sd_mod ext4 jbd2 mbcache crc16; do f=$(find $M -name "$m.ko*" 2>/dev/null | head -1); printf '%-20s %s\n' $m "${f:-(builtin or missing)}"; done
grep -E '/(loop|dm-mod|dm-crypt|ext4|virtio_scsi|9p|virtio_blk|sd_mod)\.ko' $M/modules.builtin | head
echo "## qemu virtfs/9p + virtio-scsi + rotation_rate support"; qemu-system-x86_64 -device help 2>/dev/null | grep -E 'virtio-9p-pci|virtio-scsi-pci|"scsi-hd"' | head; qemu-system-x86_64 -device scsi-hd,help 2>/dev/null | grep -i rotation
echo "## tools for an initramfs"; for t in cpio busybox bash kmod modprobe mount python3; do printf '%s ' $t; command -v $t || echo missing; done
echo "## end"
