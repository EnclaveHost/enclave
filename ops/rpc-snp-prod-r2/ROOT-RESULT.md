# Enclave RPC production run r2 (SEV-SNP on Warden) — RUNNING, not yet serving

Unit `enclave-rpc-snp-prod-r2` (transient systemd user unit, KillMode=mixed, QMP
power-off on stop, Restart=on-failure), launched by a pinned copy of
`rpc/snp/launch.py` with image r4 (IMAGE.json), 8 vCPU / 26 GiB, the caught-up L1 COW
(rpc-l1-catchup-af67c013.../l1.qcow2 over the frozen 856ca -> r6 -> l1-origin chain)
as its only chain disk, attested front on 127.0.0.1:18443.

Image fixes on the way here: r3 baked the measured client memory limits (r2's 4.5/6.5
GiB MemoryHigh throttled Lighthouse into thrashing in the catch-up run); r4 binds
cloud-init's instance-id to the runtime identity (prod-r1 on r3 failed
enclave-rpc-identity, so EL/CL never started; stopped cleanly).

Attestation VERIFIED (VERIFY.txt): AMD KDS VCEK chain to the pinned Turin ARK, VMPL 0,
DEBUG/MIGRATE_MA off, measurement ab6c59ac...e3c equal to the offline 8-vCPU
sev-snp-measure (EXPECTED-MEASUREMENT-8VCPU.txt), report_data bound to the live TLS key.

Inside the enclave: identity PASS, EL and CL started, Base not started (no disk).
Beacon API answered at once (head 15522751, still range-syncing ~41.7k slots). EL HTTP
not yet answering: the catch-up VM before this was stopped uncleanly (systemctl stop
with KillMode=control-group SIGTERMed QEMU), so reth is expected to run its unclean-
shutdown recovery first. No client query has succeeded yet; no consumer routing.
