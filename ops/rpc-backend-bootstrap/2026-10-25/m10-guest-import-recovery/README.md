# Guest native validation: test import correction

Attempt 1 passed 152 engine tests, then node test compilation failed because its new nested test module lacked `EngineError`. The exact compile error and resource receipts are preserved in `attempt-1/`; this was not a memory-limit failure.

The correction adds one test-only import. Stage sources and derivation proofs are in `stage/`. Six watcher controls, source derivation, transfer integrity and guest preflight passed (`stage-validation/`). Attempt 2 is running; no node, CLI or negative-control pass is claimed yet.

Attempt 2 reuses the ended first run's cargo-home and target as mutable caches, preserving its source and receipts. The unit remains limited to 12 GiB and two CPU cores, with guest and host 16 GiB available-memory floors and an 8 GiB disk floor. No chain service configuration or app deployment changed.
