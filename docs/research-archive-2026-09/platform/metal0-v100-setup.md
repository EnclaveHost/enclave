> Superseded by [the pooled GPU deployment](./metal0-gpu-pool.md) on September 5, 2026. The separate-card pricing below is historical.

# Metal0 shielded GPU expansion

Deployed 2026-09-05: `v0.5.568-cpu`. Source commit `b14f9916`; CI manager repin `d0999463`.

| Card | UUID | Budget | Compute | Verified SMs |
|---|---|---:|---:|---:|
| NVIDIA GeForce RTX 3070 | `GPU-75f32211-2a00-2fb0-703f-99a11bbe5977` | 6.5 GiB | 50% | 22 |
| Tesla PG500-216 | `GPU-1397d8cd-27ae-e1a6-a7ed-e485e7ca002c` | 31 GiB | 100% | 72 |
| Tesla V100-PCIE-32GB | `GPU-042eb279-e6e6-9866-5823-015b8d26946a` | 31 GiB | 100% | 80 |

The existing RTX 3070 retains its 6.5 GiB budget and 50% host MPS cap. Both V100-class cards use full compute. Their explicit worker environment overrides the old worker-local 50% default.

Validation:

- Both V100s passed exact masked GEMM, result verification, deliberate-lie rejection, and operation-denylist enforcement, on the host and through the booted SNP guest.
- Simultaneously reserved 31 GiB on each card (62 GiB total); extra reservations were refused and all memory was released on disconnect.
- Allocation, per-card routing, independent fairness queues, duplicate-card rejection, per-card failure withdrawal/recovery, CPU admission, and guest verdict publication passed regression tests. CI unit/e2e/contract checks passed.
- Chromium at enclave.host/dashboard visibly showed three separate GPU rows and both 31 GiB V100 budgets.
- All six app records reported running, and all six public HTTPS endpoints responded successfully after certificate renewal. Metal0 health reported six restored deployments and a fresh watcher. The automatic update timer was restored.

Configuration:

- Local configuration: `/home/steven/Projects/enclave/metal/config.json` (contains secrets; not copied into this report).
- GPU IDs 0/1/2 bind stable UUIDs to worker TCP/vsock ports 9500/9501/9502.
- New workers each use `vramGb: 31`, `computeShare: 1`, and `workerEnv.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE: "100"`.
- Price updated at the user’s request to $0.25 per card-hour for all three workers (Metal0 publishes one shared GPU rate). The ledger represents this as 69 micro-USDC per second, or $0.2484/hour before per-deployment rounding; the dashboard displays $0.25/hour.

Operating limits:

- Each tenant uses one GPU. Memory is not pooled across cards.
- Legacy single-card sizing fields remain based on the smallest card; individual capacity is exposed in `/availability.shieldedCards` and `/v1/gpu`.
- The six existing deployments allocate all of Metal0’s current CPU/RAM shares. Additional GPU deployments still require CPU/RAM capacity.
- This adds shielded inference capacity; no streaming-performance claim is made.
