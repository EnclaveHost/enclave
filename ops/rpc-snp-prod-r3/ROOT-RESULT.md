# Enclave RPC production run r3 (image r5) — RUNNING, syncing, not yet production-ready

r2 stopped through its normal path (QMP power-off): console shows enclave-rpc-cl and
enclave-rpc-el stopped cleanly and the guest powered down (exit 0, requestedStop).
r3 = image r5: the front adds a bounded read-only `GET /logs/{el,cl,base,front,identity}`
journal tail for operators (host-loopback port; a public gateway forwards only RPC,
attestation and health). Expected 8-vCPU measurement in EXPECTED-MEASUREMENT-8VCPU.txt.
Same L1 COW; host disk guard `rpc/snp/disk_guard.py` stops the unit cleanly if /vm free
< 200 GiB (the launcher itself has no disk floor; a full disk would pause QEMU).

State at start: reth pipeline MerkleExecute 26278125 -> 26279499 after Headers/Bodies/
Execution/hashing to 26279499; beacon optimistic range sync, ~40.9k slots behind.
Base absent (no NVMe disk yet). No consumer routing.
