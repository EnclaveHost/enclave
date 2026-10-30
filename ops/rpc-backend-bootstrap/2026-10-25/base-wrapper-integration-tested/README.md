# Base wrapper integration candidate — tested offline, deployment on hold

The production wrapper captured from the RPC VM matches committed source df15955ce byte for byte. The candidate preserves the existing mount, binary, retention, coverage, L1 and blob readiness checks and explicitly disables L1 RPC trust. It adds opt-in versioned binary selection and a proposed root-owned bootstrap lifecycle.

Root ran the unchanged baseline suite (34), unchanged suite against the candidate (34), and 14 new release/refusal/lifecycle tests: all 82 passed, with no skips. Actual root-base-wrapper-tests-0112 exit 0, peak 6 MiB, minimum host available 23372 MiB. Tests use fake mount/RPC/exec boundaries and do not boot a chain client or inspect a live database.

This is NOT ready for deployment. LAUNCH_PRODUCER_REVIEWED remains False. No reviewed producer yet binds all A1–A4, bytecode, database, binary, coverage and lifecycle evidence; no launch records were fabricated. Do not flip that guard based on these unit tests. Restart/rollback qualification on the rebuilt database, complete downloaded history, historical blobs, and safe/finalized readiness remain required. No live wrapper, manifest, service, app or administrator control changed.
