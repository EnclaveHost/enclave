# Measured loader memory reduction — October 28, 2026

Four isolated boots (A/B then B/A) loaded and SHA256-verified the same 17,559,178,144-byte public Qwen model. The same static loader binary ran in both arms. Only the measured drop-cache marker differed; the full private model copy and pinned digest remained mandatory.

| Arm | Host cgroup peak, sampled (GiB) | Guest loader cgroup peak (GiB) | Copy and verify (seconds) |
|---|---:|---:|---:|
| A: advice off, first | 36.107 | 32.755 | 30.494 |
| B: advice on, second | 19.743 | 16.403 | 21.609 |
| B: advice on, first | 19.719 | 16.403 | 21.511 |
| A: advice off, second | 36.091 | 32.751 | 30.232 |

The measured loading reduction is approximately 16.37 GiB of host RAM. Advice calls reported no errors. Reverse order reproduced the difference; this is two observations per arm, not a broad performance distribution. Host memory.peak was read once per second; the last readable peak is a lower bound. Guest child memory.peak was captured after exit.

This qualifies the loading experiment only. It does not establish full-model registration/inference peaks, decode throughput, concurrency capacity, production admission limits, or independently verified SNP attestation. No production runtime, policy, floor, GPU, wallet or app was changed. No experiment funds were spent. Packed24 remains separate and was not enabled here.

## Controls and validation

- Each guest: 48 GiB, two vCPUs, pinned production kernel/firmware, new minimal initramfs, readonly public-model disk, no networking/GPU/chain/lease/signing. QEMU configured SNP; no attestation report independently verified.
- Owned user unit: 50 GiB/no swap/200% CPU/180 seconds. Guest loader child: 45 GiB/no swap/150 seconds.
- The host reserved 18 GiB plus all 13 GiB of existing guests' nominal RAM again. All three existing QEMU identities were checked before each boot and throughout; a competing guest would stop only the canary. Both shared coding lanes were held during each A/B run.
- All four owned units/processes cleaned up. Production image HTTPS returned 200 afterward.
- Seven Go init tests and 23 Python fixture tests passed, no skips. Tests cover corrupted serial records, refused storage, launch failure, memory pressure, competing guests, changed unit identity and cleanup. The ordinary-file swap-control fixture initially failed because a nontruncating write left stale characters; corrected fixture, no cgroup guard relaxation. Initial root test service lacked its working directory and ran no tests; the successful rerun is preserved separately.
- Bounded static build peak61.6 MiB; no swap. Loader's nine existing tests are in ../loader/tests.txt.

`RESULTS.json` contains exact numbers. `evidence/` contains both plans, full public synthetic serial records, sampled host memory, final receipts, build manifest and test outputs. Paths describe the observed local machine; do not replay old plans. Build fresh artifacts and review a fresh plan against live resource commitments. Use run_coordinated.py for execution so shared queue locks are enforced.

The next gate is a separate full-inference comparison using the installed backend and identical workload, followed by pressure/security/attestation checks. Only measured results can justify a smaller admitted guest.
