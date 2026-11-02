# Enclave RPC production run r5 — I/O threads for chain disks

Diagnosis on r4: beacon range sync ~0.9 slots/s (~12 h to head). QEMU's main loop thread
was ~85% CPU in D state: with no iothread it handled every chain-disk completion as
well as user-mode (slirp) networking. passt is not installed (needs root), so the
network backend stays slirp.

Change (`rpc/snp/launch.py`): each chain disk gets its own `iothread` and
`num-queues=4`. Host device plumbing is outside the SNP launch measurement (firmware,
VMSA/vCPU count, kernel/initrd/cmdline hashes), so the expected measurement is unchanged
(image r6, ops/rpc-snp-prod-r4/EXPECTED-MEASUREMENT-8VCPU.txt).

r4 stopped cleanly (QMP power-off, clients stopped, guest powered down, exit 0); r5
started on the same L1 disk. Measured after settling: main thread 6.9% CPU, io0 33%,
beacon range sync 3.05 slots/s (~3.5 h to head at ~38k slots). Base still not attached.
