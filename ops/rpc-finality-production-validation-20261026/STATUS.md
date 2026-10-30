# Production RPC validation checkpoint — 2026-10-26

NOT QUALIFIED or activated. Production consumers still use public RPCs. Administrator controls unchanged.

Actual guest light client authenticated finalized forward progress from checkpoint block 26271752 to 26275066, matching own EL. Capture then FAILED because initial configuration retained workstation EL port28645 rather than explicit guest18645. Verification separately fails with undefined py in the runtime record check. PIDs unchanged, cleanup completed, host floor maintained. Only the bounded public receipt is included; full private captures remain local.

Actual r9 qualification FAILED. Tool34, readiness27, installer13, both parser8 suites and forward-sync-r2 six tests pass. Integration17 fails; reproof one failure/seven errors; recovery/r62/forward import failures from undefined WORK; r3 regression27/28. Raw receipts preserved. Runtime-pin stage was UNRUN at the r9 checkpoint; the later r10 root run passed all10 runtime-pin tests. r10 overall still failed other suites and is not qualified. These artifacts are source preservation, not release/production-readiness evidence.

Subsequent r10 repair is in progress separately. Snapshot download/extraction, historical blobs, Base authenticated safe/finalized proof serving, mined transactions, restart/outage and consumer cutover remain prerequisites.
