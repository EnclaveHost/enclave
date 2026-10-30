# witness-producer-service-stage/r7: fixture correction only (root 1620). PREPARED by Claude; nothing run

Report: `logs/claude-producer-r7-fixture-1625.md`. r1-r6 are frozen and unchanged.

- **`producer/witness_producer.py`** is **byte-identical to r6's**; the job `cmp`s it. There is no runtime change.
- **The defect (r6, 1620):** in `tests/test_witness_producer_r6.py`, `Ownership.test_a_reaped_fetch_is_never_signalled…` called `self._raw_post`, which r6 defined only on the `Shutdown` class. Its client thread died with `AttributeError`, never sent the request, and the test then (correctly) never observed the post-reap window.
- **`tests/test_witness_producer_r7.py`** (14): r6's tests with the same assertions. `Base` now provides:
  - `raw_post()`: a real HTTP exchange that does **not** wait for quiescence, for tests that observe the server mid-request;
  - `background()`: a client thread whose exception is captured and re-raised, and which a cleanup always joins (bounded; it fails if still alive);
  - `joined()`: joins it and returns the result or raises;
  - `bg_alive()`: inside wait loops, a dead client fails at once with its own exception.

  `Shutdown` and `Ownership` use them; `Shutdown._raw_post` is removed.
- **`tests/test_forward_chain_r7.py`** (7): r6's, byte-identical (it imports its own stage's producer, which is the same bytes).
- **`jobs/tests.sh`:**
  - exact counts 14 + 7;
  - the r1-r6 sums, and the r6 producer byte identity;
  - the bridge source pin;
  - it fails on any printed `Exception in thread`, and on orphaned fixture processes.
