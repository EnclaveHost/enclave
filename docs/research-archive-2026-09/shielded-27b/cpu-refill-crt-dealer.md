The final opt-in CPU refill implementation reduced median complete 64-row pad shipment time from 3.052 to 2.211 seconds (27.6%) in a balanced six-pair comparison using the actual Qwen3.8 27B Q8 model. That corresponds to 20.97 versus 28.95 full-model pad rows per second. These are pad-production rates, not inference tokens per second.

Each row covers all 262 groups / 409 registered model members. Each shipment is 809,039,872 bytes. The timed call includes pad derivation, matrix products, encryption and local file publication. It excludes model registration (18.592 seconds), initial identity hashing (16.358 seconds), the warm pair and subsequent comparison/cleanup. No GPU or phone participated.

| Pair | Order | Default wall (s) | Opt-in wall (s) | Reduction |
|---:|---|---:|---:|---:|
| 1 | AB | 2.958730 | 2.176551 | 26.4% |
| 2 | BA | 3.020269 | 2.807431 | 7.0% |
| 3 | AB | 3.053722 | 2.729868 | 10.6% |
| 4 | BA | 3.627556 | 2.218120 | 38.9% |
| 5 | AB | 3.235100 | 2.161660 | 33.2% |
| 6 | BA | 3.050838 | 2.203293 | 27.8% |

The opt-in won all six matched pairs. Median process CPU time fell from 44.335 to 31.807 seconds per shipment (28.3%). The desktop host was not affinity-isolated, and individual wall times vary; this is one balanced block, not a universal speed guarantee. An earlier separate-object prototype comparison also passed and favored the candidate in all six pairs, but its absolute timings are recorded separately in the evidence.

The benchmark used 16 mint threads, a fully checked warm pair and then three A/B plus three B/A pairs. Within each pair both variants used identical test seeds and indices; subsequent pairs used fresh index ranges. The authenticated reader compared all 269,582,336 field values per pair, including the warm pair. Both implementations also passed independent int64 kernel oracles covering 6,120 normal/extreme/tail cases and 320 normal/forced-allocation-failure pairs per entry. Optimized and sanitizer checks passed, as did seven admission/override cases and Android arm64 compilation.

The final benchmark uses the actual static production tables, with a scratch-only selector called between completed mints after all mint workers have joined. It does not introduce a mutable production selector. The source adds `SHIELDED_REFILL_VECTOR_CRT=1`, default off; the selected table is fixed at first admission and its arithmetic is checked against the generic implementation. Small batches, ARM/NEON and the generic implementation retain their existing paths.

The 101.698-second run completed with all identity/stability gates satisfied, its owned child reaped and private pad files removed. This workstation has no established confidential-computing boundary; isolated test pads were used, and this benchmark does not authorize real secret generation on an untrusted host.

Final benchmark library SHA-256: `f83459d58636fb9d5338a68ab1b01bf5f6784e1d24f6e60520d957633411d53c`. Benchmark SHA-256: `78af89be1999c9179ad7b239bd3db65c2c4dd35bd9cef7e21b1e79edded175ad`. These include scratch benchmark hooks and are not deployment binaries.

[Complete evidence](cpu-refill-crt-dealer-evidence.json) contains both comparisons, source/build identities and every timing/verification record.
