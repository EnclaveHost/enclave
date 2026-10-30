# State wiring and namespace launch safeguards

State runtime r2 actual20 tests passed: pre-execution view binding, exact build and structural receipts, capture output/evidence checks, cleanup failure propagation, and strict test receipts. Extraction adapter and actual production inputs remain intentionally blocked pending integration and actual evidence.

Launch guard r2 actual12 tests:11PASS/1FAIL; test2 expected record omitted the new allNamespaceHazards field. Root r3 changes only revision labels and that expected field. Actual r3 all12 passed. Non-desktop FUSE anywhere in the namespace is refused, and full namespace qualification evidence is required for capture. The real namespace test, Rust build, compiled fixtures, extraction E2E, structural/state/canonical validation and RPC cutover remain unperformed. Local synthetic tests do not establish recovery or production readiness. Original USB writes and the RPC VM remain paused.
