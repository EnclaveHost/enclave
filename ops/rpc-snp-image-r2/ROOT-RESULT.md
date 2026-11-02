# Measured SEV-SNP RPC image r2: built, booted, attested, verified

Built by `rpc/snp/build_image.py` (58 s): the pinned RPC guest OS (boot.vhdx sha256
a76940c9...) plus the direct-seed runtime files, SNP report modules from Ubuntu's
signed linux-modules-extra-6.8.0-147, the dm-verity local-top/hook, the attested front
(`rpc/snp/front.py`), chain clients and front enabled at boot, 300 s clean-stop
timeouts, read-only root + overlayroot tmpfs, SSH masked and cloud-init disabled.
IMAGE.json pins every artifact; cmdline carries the verity root hash
f9b170822cd7466dd4cc5f0f5c87aeff1d3fa6c41225748aa53140fefc962b07.

Booted by `rpc/snp/launch.py` (2 vCPU, 4 GiB, no chain disks, front on 127.0.0.1:18443):
dm-verity opened the root from the measured hash, overlayroot tmpfs, SEV-SNP active,
front stages starting -> attested -> ready (console). Stopped by QMP power-off
(exit 0, requestedStop true).

Verification (VERIFY.txt, metal/verify.mjs --rad with AMD KDS): report v5 VMPL 0,
policy 0x30000 (DEBUG/MIGRATE_MA off), VCEK signature valid, VCEK->ASK->ARK, ARK is
AMD's pinned Turin root, chip ID/TCB match, launch measurement
df6576b42486be7f59713c85535dfc4d62d266c0b55585a997714853e79925e430b014e165210c3525b6c0d646f7033b
equals the offline `sev-snp-measure --mode snp --vcpus 2 --vcpu-type EPYC-v4` of
OVMF.amdsev.fd + vmlinuz + initrd.img + cmdline, and report_data binds the live TLS
key. Result: VERIFIED. TCB floor not judged (no --min-tcb). /health answered (nodes
down, no disks); eth_sign refused by the front's allowlist.

Measurement depends on vCPU count; production uses its own count and recompute.
Not yet: chain disks, synced clients, serving queries, consumer routing.
Production RPC remains OFFLINE.
