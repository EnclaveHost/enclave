# witness-producer-service-stage/r4: real-run corrections (root 1603/1604). PREPARED by Claude; nothing run, built or installed

Report: `logs/claude-witness-r4-real-failures-1605.md`.
- **Frozen and unchanged:** r1, placement r2 (units, proposal, transport patch) and producer r3. r4 uses r3's producer and r3's 10-test suite **by path**, and r2's units and proposal by path, all sha-pinned. Nothing is copied.
- **Only file:** `tests/test_forward_chain_r4.py` (7 tests): r2's forward harness, moved onto the r3 producer and corrected.
  - **1603 503:** real single-flight admission, not a producer defect. The readiness probe through `systemd-socket-proxyd` made the proxy open an upstream producer connection, which held the one slot when the first request arrived. The fixture now waits until the producer has released it. New regression: an idle forwarded connection holds the slot, a concurrent request gets 503 unread in < 2 s, and after close the next request is served.
  - **1603 `[Install]`:** the check matched a comment. The unit sections are parsed now (socket `[Unit][Socket]`, service `[Unit][Service]`), and the bind and peer checks run on non-comment lines.
- **`jobs/tests.sh`** (1604 fix): the archived r14 `SHA256SUMS` lists an absent `.pyc`. The archive is not re-verified as a whole and never edited. The bridge **source** is pinned directly to its reviewed `cb976541…`, which is also its own line in that file, and the r1/r2/r3 sums are re-verified.

**Expected:** r3 suite `Ran 10 tests` OK, and r4 forward suite `Ran 7 tests` OK, with no skips.
