# RPC guest OS under SEV-SNP on Warden, r1 (feasibility)

One bounded boot (`enclave-rpc-snp-boot-r1`, 600 s limit, exit success after an
in-guest poweroff). Same RPC guest OS as the direct diagnostic runs (Ubuntu 24.04,
kernel 6.8.0-147, reth/lighthouse/base in /opt/enclave-rpc/bin), private overlay of
the Nov 1 boot disk, no chain disks. Launch exactly as `launch.sh`: QEMU
`sev-snp-guest` with `kernel-hashes=on`, Warden's OVMF.amdsev.fd (as metal0),
measured direct boot of the image's own vmlinuz/initrd (KERNEL-SHA256SUMS) and
cmdline `root=LABEL=cloudimg-rootfs ro console=ttyS0`, memfd guest RAM, virtio-blk,
virtio-net (user mode, SSH hostfwd on loopback).

Result:
- guest dmesg: `Memory Encryption Features active: AMD SEV SEV-ES SEV-SNP`, SNP
  CPUID table, SNP guest platform device initialized; boot to login in ~10 s.
- The cloud image lacks sev-guest/tsm modules; loaded from Ubuntu's signed
  linux-modules-extra-6.8.0-147 package into tmpfs (test overlay only).
- configfs-tsm report: provider `sev_guest`, 1184-byte SNP report, launch
  measurement f5da036c72fe8972f28dc960dcd4983864166e06d62b57067bd9c7121f55bcab950237d99b18637c3899f10cd924dddb.
- Image already ships overlayroot initramfs script, veritysetup and dm modules.

Meaning: the RPC stack can run as an attested SNP guest on Warden with local NVMe
chain disks and a NIC for p2p, which the no-NIC native Hyper-V design cannot. NOT
yet: verity-protected immutable root (root disk here is writable and unmeasured),
in-image modules, report verification against an independently computed
measurement, chain disks, serving, consumers. Production RPC remains OFFLINE.
