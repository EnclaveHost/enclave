# Custody verifier source validation, 2026-10-25 22:42 UTC

Reviewed source is committed on fix/rpc-relay-consumers-20261025 at e78a764d1. V1 gains an explicit local-verifier option; v2 explicitly refuses that client until its canonical-hash requirement is supported. Existing deployments and policies are unchanged.

Root r4 passed11 new tests and101 regression tests; the pristine baseline passed the same101. No skipped tests, no baseline-only or patched-only failures; actual queueexit0, peak230MiB/minimum host available22418MiB. The r3 failure is retained: four stale v2 test expectations and a root harness mistake (loopback interface not enabled). r4 fixes only fixtures/harness; production source stayed byte-identical. The earlier r2 hash-to-number translation was rejected and is not in the committed implementation.

Limits: simulated verifier peers, no live secret migration or measured-image change, no L1 finality claim. v2 host public-RPC default remains pending. Reports retain historical preparation states; this README and actual r4 receipts describe the reviewed result. The original MANIFEST references full private test trees not included here; PUBLICATION-SHA256SUMS covers the published files.
