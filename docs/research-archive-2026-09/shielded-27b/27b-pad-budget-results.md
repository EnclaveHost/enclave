The latest complete 27B Q8 run produced **1.189 tok/s** and **0.992 tok/s**, or **1.082 tok/s combined** over 32 generated tokens. Both trials returned identical text and MTP decisions. The cycle completed in **8 minutes 31 seconds**, including cleanup. This build adds diagnostics; the higher speed than the previous run does **not** establish an optimization gain.

| Measurement | Trial 1 | Trial 2 |
|---|---:|---:|
| Generated tokens | 16 | 16 |
| Decode time | 13.456748 s | 16.124225 s |
| Overall tok/s | 1.188995 | 0.992296 |
| Steady tok/s | 1.254421 | 1.090385 |
| Cumulative wire time | 8.9625 s | 11.2583 s |
| Reply poll elapsed time | 7.5697 s | 9.3624 s |
| Reply poll CPU time | 0.2300 s | 0.2730 s |
| Offloaded / local nodes | 2,441 / 0 | 2,441 / 0 |
| Pads used / missed / waited | 6,764 / 0 / 0 | 6,764 / 0 / 0 |

Each trial performed 720,956,293,120 offloaded MACs and 1,574 exchanges, sending 171,091,626 request bytes and receiving 355,289,430 reply bytes. Verification failures were zero. The assigned V100 U1 reached **25,856 MiB** of allocated memory. These cumulative timers include nested and potentially overlapping work; their sum is not elapsed inference time.

The first new pad-body transfer began **12.702834–12.703028 seconds after the first timed inference request**, using the measured guest/phone clock bounds. The preceding shipment had already been acknowledged. Thus new pad-body transfers cannot explain most of the first trial's delay. The marker is placed immediately before the body copy after header admission; this observation does not exclude pads-port header or control traffic. The separate app-log timing gives an approximate 12.691 seconds after the app received BENCH begin.

All four snapshots reported every one of the 262 groups, with no busy or missing observations:

| Snapshot | Reader index intervals | Ready pads per group | Scheduled cursor range |
|---|---|---:|---:|
| Before trial 1 | [0,128) | 19–23 | 24–28 |
| After trial 1 | [80,128) | 54–62 | 92–136 |
| Before trial 2 | [80,128) | 54–62 | 92–136 |
| After trial 2 | [80,176) | 33–45 | 96–184 |

Per-group consumption sums matched the link counter: 6,764 in each trial. The sampling intervals were 25–53 microseconds per card; this excludes log output overhead. Reader intervals describe resident files at the observation time. The cursor records scheduled imports, and the bind epoch is unknown, so these observations do not certify future pad availability.

Validation passed: both complete inference trials, 13 standard analyses, 10 additional analyses, 135 parser checks, and 42 inventory-summary checks. Three permanent C fixture cases passed across two bounded runs after correcting the test helper's C standard. Runtime commit `c0a01a36`, test-only commit `452bffb9`, APK v51; both commits remain local and unpushed. Production defaults are unchanged.

The next experiment under review pauses app-to-VM pad sends around inference. Its control and cancellation paths are being tested before it can run. A separate Opus task is reviewing the measured ordinary reply path. No speed improvement from either proposed change is claimed yet.

[Full measurement and source hashes](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-pad-budget-results.json) · [Inventory summary](/home/steven/Documents/Codex/2026-09-07/i-w/work/pad-budget-root-summary-3/device-summary.md)
