# Recovery tools: qualification incomplete, 2026-10-26 21:02 UTC

No original database was restored, exposed or validated by these jobs. No production cutover occurred. USB writes and production VM startup remain paused.

- Matching official libmdbx 0.13.12 tools compiled successfully from pinned Base/reth vendored sources. MDBX checker SHA256 c228b462c3c71c87b0fd2e9cfa6b3e6bccb2d793dd545bc6a18bef7113187981.
- Validator r1 fixture setup failed before any test because its builder treated the documented successful MDBX_RESULT_TRUE from mdbx_env_sync_ex as an error. Fix pending. The wrapper also needs nonblocking timeout and descendant cleanup before use. The initial 2048 MiB queue request was rejected; actual build used supported 2560 MiB cap, peak 403 MiB, minimum host available 23809 MiB.
- Overlay r1 fixture setup failed before any test because block-list parsing included debugfs stderr banner. No mounts remained and peer processes/mounts were unchanged. Hard bounds, cleanup, chronology and result propagation require r2 before a real recovery view.
- Memory audit distinguishes configured ceilings from measured needs. The existing 64 GiB VM cannot fit while preserving current apps and the 16 GiB host floor; no resources or manifests changed.

Earlier recovery evidence remains valid but does not establish complete database integrity. Full structural validation plus Reth state and independent chain-root verification remain required; samples are insufficient. No database bytes, copied journal or binaries are included here.
