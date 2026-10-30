# Actual r10 namespace qualification

Five namespace tests passed on 2026-10-27 at 09:10 UTC in the exclusive 512 MiB shared queue, between recovery batches. The receipt binds frozen r10 SUMS. The run was shorter than the memory sampler interval: peak0/minimum n/a is not a measured zero-memory claim. Queue admission reported24437MiB available versus17152MiB required.

This completes r10 wrapper/namespace qualification only. The corrected Rust is in r11, whose own namespace receipt remains pending. No Rust compilation, compiled fixture run or production database validation occurred. No original or recovered data was read by these tests. The all265 recovery prerequisite remains in force.
