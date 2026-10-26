# witness-producer-service-stage/r5: deterministic lifecycle (root 1610). PREPARED by Claude; nothing run, built or installed

Report: `logs/claude-witness-r5-lifecycle-1611.md`. r1-r4 are frozen and unchanged; r2's units and proposal are used by path.

**`producer/witness_producer.py`** = r3 plus exactly:
- **Observable completion:** `admitted`/`completed` under one condition variable; `wait_quiescent()` (every admitted handler finished: cleanup, log, slot release) and `wait_admitted(n)`. A client has its last byte before the handler's cleanup/log/release (root's finding), so anything that needs those observes completion. Nothing sleeps.
- **Shutdown, a real r1/r3 defect:** `shutdown()` used only to close the listener. Handler threads and the fetch child (in its own session) were orphaned. Now it refuses new work, SIGKILLs every registered fetch process group (pids are unregistered once reaped) and joins the workers (bounded), returning the names of any still alive.

**Tests (18 = r4's 17 + 1 genuine regression):**
- `tests/test_witness_producer_r5.py` (11): r3's 10, with every `post()` followed by `wait_quiescent()` and teardown asserting `shutdown() == []`, plus `Shutdown`: a running real fetch child is killed, its handler joined, the client gets 502, the work dir is clean, and new connections are refused.
- `tests/test_forward_chain_r5.py` (7): r4's 7, with readiness = one complete malformed exchange through the real proxy (400, read to EOF) plus the handler's observed completion; only connection-refused is retried. The idle regression waits for the idle client's actual admission (`wait_admitted`), asserts 503 via the producer's `busy` count, and observes the idle handler's completion before the next request gets 200.

**`jobs/tests.sh`:** exact counts 11 + 7, the r1-r4 sums, the bridge source pin (1604) and no orphaned fixture processes.
