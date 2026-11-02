#!/bin/sh
# One bounded SNP boot of the RPC guest OS: measured kernel+initrd+cmdline, private overlay, no chain disks.
exec /usr/bin/bwrap --die-with-parent --new-session --unshare-user --ro-bind / / --bind /vm/enclave-volumes/rpc-snp-boot-r1 /vm/enclave-volumes/rpc-snp-boot-r1 --dev /dev --dev-bind /dev/kvm /dev/kvm --dev-bind /dev/sev /dev/sev -- \
 /usr/sbin/qemu-system-x86_64 -name rpc-snp-boot-r1 -machine q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0 \
 -cpu EPYC-v4 -smp 2 -m 4096 -object memory-backend-memfd,id=ram0,size=4096M,share=true,prealloc=false \
 -object sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=/dev/sev \
 -bios /home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd -kernel /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-snp-boot-r1/vmlinuz -initrd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-snp-boot-r1/initrd.img \
 -append 'root=LABEL=cloudimg-rootfs ro console=ttyS0' -nodefaults -no-reboot -display none -serial file:/vm/enclave-volumes/rpc-snp-boot-r1/console.log -monitor none \
 -drive file=/vm/enclave-volumes/rpc-snp-boot-r1/boot.qcow2,format=qcow2,if=none,id=os0,cache=none -device virtio-blk-pci,drive=os0 \
 -drive file=/vm/enclave-volumes/rpc-linux-direct-856ca36204b44e39816d6894807c8c6d/direct-seed/seed.iso,format=raw,media=cdrom,readonly=on \
 -netdev user,id=net0,hostfwd=tcp:127.0.0.1:22498-:22 -device virtio-net-pci,netdev=net0
