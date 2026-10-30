# Development checkpoint — unqualified and not installed

Administrator controls and production traffic remain unchanged. This preserves r6 source, actual failing qualification and read-only blob prerequisites. No readiness or cutover claim is made.

Original r6 qualification exited 1: tool 30/34; integration failed import; sampler 92/92 passed; recovery 9/24 passed with 15 binary-pin errors; regression 13/27 passed with 14 errors; existing recovery 34/34 passed. The two ported suites require investigation of launch binding versus production binary constants. JS evidence reused only for unchanged pinned source.

A test-fixture repair ran the four previously failed tool cases successfully. Integration now runs: 14/16 passed, one error exposes a leaked harness Refused exception when capture is held, one assertion expects rollback before the stronger global-floor guard. No security refusal was bypassed. The first subset launch never ran tests because two fixed-file hashes were transposed in its job; root corrected just those constants and regenerated the stage manifest before the actual run. The preserved Claude report predates that correction.

A separate actual counterexample proves the readiness helper accepted a fresh cached READY record for nonexistent PID 999999999. It is evidence of a defect, not a passing product test. Review also identifies readiness lifetime/cycle mismatch and nontransactional installer writes. Separate fixes are in progress; r6 is frozen and must not be installed.

Historical blob evidence shows the local L1 currently retains the estimated snapshot-origin window, but an exact origin and a per-block coverage verdict do not exist until Base extraction. Estimated range already exceeds the default 12000-block limit; a reviewed explicit bound is needed. No remote-RPC fallback or archive assumption qualifies this path.

Stage paths reference the qualification workspace; this directory is an evidence checkpoint, not a standalone deployable bundle. Recovery/ops follow-up work and actual production qualification remain required.
