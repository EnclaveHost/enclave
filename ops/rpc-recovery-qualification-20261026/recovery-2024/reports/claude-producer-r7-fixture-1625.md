# Witness producer r7: fixture-only correction (root 1620). Source only; nothing run, built or installed - 2026-10-26

## Stage: `witness-producer-service-stage/r7`, FROZEN
**`SHA256SUMS` = `ab4083e4b06d8920892734eed9a30980f0aaeabcfe4869047682723bc3bd8f81`** (hashed with `sha256sum`; files `a-w`).

| file | sha256 | note |
|---|---|---|
| `producer/witness_producer.py` | `1fc2ea3266c7b9cda1619f83d8603ea25aa6232075c769bc386b2b18eb0d4d14` | **= r6, byte-identical**: no runtime change; the job `cmp`s it |
| `tests/test_witness_producer_r7.py` (14 tests) | `f336f802e1a39939d939f2f12a6376b43104533fd799de27103944ea1ad04e71` | the only changed source |
| `tests/test_forward_chain_r7.py` (7 tests) | `62ee60268583617393134d4d16bc95fe5998eab30b0a381b4868a10fd2bbfc08` | = r6/r5, byte-identical |
| `jobs/tests.sh` | `bd45002bb06674b2aec1f64145f67c1369c49049c36c39e9711ead7619f6033a` | |
| `README.md` | `0ac99cc4f20dd8fba81c95434ce0e64aacbc9264b11b2a99affaa13764e6f761` | |

**Unchanged (re-verified):** r6 `6851047d…`. The job also checks r1-r5.

**Scratch:** none was needed. r7 was created as a new directory (guarded: refuses if it exists) from r6's verified files; no other stage or the repository was touched.

## Root 1620: the cause (from the actual run log `r6/runs/run-20261026T201052Z-2274331/test_witness_producer_r6.txt`)
- **The failure:** `Exception in thread … AttributeError: 'Ownership' object has no attribute '_raw_post'`. Then `FAIL: test_a_reaped_fetch_is_never_signalled… never observed the post-reap, stderr-still-open window`.
- **Everything else passed:** the other 13 producer tests, and the forward suite (7, OK).
- **The defect:** r6 defined `_raw_post` only on the `Shutdown` class. The new `Ownership` test (a separate `Base` subclass) called it from a thread, so no request was ever sent and the window could not occur. The thread error was printed, not raised.
- **The runtime ownership fix is not implicated:** the test never reached it.

## The r7 correction (no assertion weakened; no runtime change)
**New `Base` helpers:**
- **`raw_post(data)`:** a real HTTP exchange that does **not** wait for handler quiescence, for tests that observe the server mid-request.
- **`background(fn)`:** runs the client in a thread and captures any exception. A registered cleanup **always joins it** (60 s bound; it fails if the thread is still alive) and re-raises its exception, so a client thread can neither fail silently nor outlive the test.
- **`joined(box)`:** joins, asserts the thread finished, re-raises its error, and returns its result.
- **`bg_alive(box)`:** called inside the wait loops, it fails **at once** with the client's own exception, instead of waiting out a window on a dead client.

**Where they are used:**
- **`Shutdown`:** `raw_post` through `background`/`joined`; its private `_raw_post` is removed.
- **`Ownership`:** the same, plus `bg_alive` in its window loop.

**Unchanged:** every assertion, including the 200/502 expectations, the observed window condition (`grandchild` logged, `procs` empty, `active == 1`), `killpg` calls `== []` and `shutdown() == []`. The other 12 tests' bodies are unchanged.

**Job additions:**
- the r6 producer byte identity;
- the r6 sum;
- **any printed `Exception in thread` fails the suite.**

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh witness-producer-r7 512 unshare -Urn bash witness-producer-service-stage/r7/jobs/tests.sh
```
**PASS requires all of:**
- `## test_witness_producer_r7 PASS (14)`;
- `## test_forward_chain_r7 PASS (7)`;
- no skips, no printed thread exceptions, no orphaned fixture processes, and `## witness-producer-r7 rc=0`.

Exit 9 is a PRETEST refusal naming the input.

**Not claimed:** the r6 ownership fix is still unproven until this job passes, in particular the post-reap no-signal regression.
