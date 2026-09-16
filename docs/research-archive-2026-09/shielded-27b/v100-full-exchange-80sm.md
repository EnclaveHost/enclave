# Full27B-shaped worker exchange at80SM

Both graph-cache configurations passed. The larger cache eliminated capacity flushes and reduced average full-pass time in this ordered comparison. It remains an opt-in setting; this run does not establish a phone token-rate improvement.

The scratch worker used the Tesla V100-PCIE-32GB on U2. Post-context queries, planner state and HELLO all reported80SM; its own process was observed on that GPU. It used a private MPS pipe and no adjacent worker configuration. Existing service contexts remained resident, so this is not exclusive GPU use or a matched serving-MPS benchmark.

All409 nodes and262 fused groups use the actual27B registration dimensions. Values are synthetic. Each width ran2 warm and10 timed passes, with request construction outside the timed passes. A pass completes one exchange for every group; it is not an inference token.

| Rows per exchange | Cache256 full pass (ms) | Cache2048 full pass (ms) | Reduction |
|---:|---:|---:|---:|
| 1 | 43.389 | 41.180 | 5.09% |
| 4 | 63.009 | 56.731 | 9.96% |
| 8 | 99.290 | 96.636 | 2.67% |
| 16 | 188.341 | 181.292 | 3.74% |

These are host wall-clock times from sending requests to receiving complete replies over loopback. They include worker processing, transport and Python socket costs, and exclude the phone, pad generation, masking, protected verification and the rest of inference. The cache configurations were run in a fixed order; repeating in reverse order would strengthen the timing comparison.

| Cache entries | Hits | Misses | Capacity flushes | Peak entries |
|---:|---:|---:|---:|---:|
|256|0|12,588|48|256|
|2,048|11,526|1,062|0|526|

Each worker completed12,588 calls including warmup and verification. All960 selected scalar cells per configuration matched across the three verification groups and four row widths. Every recorded phase had the expected sample count, with no reported violation. This is sampled output verification; the separate kernel sweep checks every output byte.

The capture passed with396 readings per GPU across101.893seconds. U2 reached25,797MiB of reported memory and100% reported utilization at its peak. Whole-run average utilization was15.73%, including approximately77seconds of registration/upload/install and other untimed setup; it does not describe steady kernel utilization. U1 showed a small transient (maximum8%); neither owned worker was attributed to U1.

Both owned workers exited, the private directory was removed, and source/binary/geometry identities were unchanged. The binary includes the published staging ownership fix and diagnostic startup checks, compiled with host exchange profiling. The initial two-group preflight and35 CPU checks also passed.

The earlier40SM/MPS50% experiments remain separate observations. This run does not justify doubling those results or interpreting them as a matched condition.

[Detailed evidence](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/v100-full-exchange-80sm-evidence.json)
