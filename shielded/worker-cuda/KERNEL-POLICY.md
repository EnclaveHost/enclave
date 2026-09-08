# Opt-in eight-row kernel policy

Set `SHIELDED_WORKER_MR8_G4=1` before starting a scratch or newly deployed
worker to cap the planner's first candidate at G=4 for MR=8 launches. The
usual block-count threshold still permits G=2 or G=1 for small shapes. MR=1
through MR=7 keep their existing policy. A 16-row exchange uses two MR=8
launches, so both use the setting. This does not force a larger batch.

The default is off. An absent value or `0` keeps the existing planner;
any explicit value except `0` or `1` refuses startup before CUDA initialization.
The effective choice is logged at startup. Environment values take precedence
over `worker.conf`. The value is read once per process, so a cached CUDA graph
cannot outlive a change in planner policy. Existing workers require a restart
to adopt it; this change does not restart or alter any deployment.

On 2026-09-08, a Tesla V100-PCIE-32GB reporting 80 SMs completed an A/B/B/A
comparison over the exact 27B geometry (409 nodes, 262 groups), with synthetic
inputs, graph-cache capacity 2048, two warm passes and ten measured passes per
row count per fresh worker. A used the original planner; B capped only MR=8
at G=4. Averaging the two independent worker means per condition gave:

| Rows per exchange | A mean pass (ms) | B mean pass (ms) | Time reduction |
| --- | ---: | ---: | ---: |
| 1 | 40.726 | 40.363 | 0.89% |
| 4 | 55.803 | 55.284 | 0.93% |
| 8 | 92.712 | 85.720 | 7.54% |
| 16 | 179.093 | 162.392 | 9.33% |

The MR=1/4 code is unchanged; its sub-1% movement is a control observation.
MR=8 improved in both adjacent A/B and B/A comparisons (5.60/9.46% at eight
rows and 9.24/9.41% at sixteen). This is one balanced block of four workers,
not twenty independent model runs per condition. Each worker verified 960
selected scalar cells and all 12,588 exchange phase counts. A separate
seven-shape, six-pair confirmation checked every output before and after
measurement using three distinct residue planes; G=4 won all 84 matched
pairs at MR=8. MR=5/6/7 were not tested as candidate policies.

These are host loopback exchange timings, not inference or phone token rates.
Weights were public synthetic values in the real geometry. Both cards retained
live worker contexts, and the test requested a private MPS pipe and checked
actual post-context SM counts. Performance on other devices, MPS allocations,
models, packing modes or shapes remains unmeasured. Keep the production default
off until the actual protected-phone route has been validated. Wire layout,
pad domains, calibration, trusted verification and model quantization do not
change.

The production option was also compiled for sm_70 and exercised by six owned
workers with the default, explicit `0`, and explicit `1`, each at row sets
`1,4,8,16` and `5,6,7,9`. The checks passed 2,112 selected scalar cells across
72 exchanges, verified the effective startup setting, and reaped all workers.
Eleven configuration probes checked accepted and rejected values before CUDA.
These were correctness checks and carry no additional performance claim.

Measurement identities (separate scratch builds with checked device startup):

- ABBA baseline A: `cbd424eecc6f86a35c55f0f92932565b9d6804b1ea3091de17402891cf291e89`.
- ABBA MR8 candidate B: `deca44dc3bdf2e94f7437cd66a2037154de58ffcae6b08dac4587e740d92e010`.
- Geometry: `f2b90e7c19c838d9aee8f15bbc5ca8fb54afeaa83dc9bd0ef21bf243e4aefc5e`.
- Functional option check: `30e8b1753f6cc268525c6cd884a44dfc728146ffa17244fe6f6769e2198a747f`.
