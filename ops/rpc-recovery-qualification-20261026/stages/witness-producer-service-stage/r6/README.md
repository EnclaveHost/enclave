# witness-producer-service-stage/r6: owned fetch children and race-free shutdown (root 1616). PREPARED by Claude; nothing run

Report: `logs/claude-witness-r6-owned-shutdown-1618.md`. r1-r5 are frozen and unchanged; r2's units and proposal are used by path.

**`producer/witness_producer.py`** = r5 plus exactly:
- **Owned children:** `procs` holds the `Popen` objects. The ONLY reap (`p.poll()`) and the unregistering are one critical section under `cv`; there is no `p.wait()` outside it any more.
- **Kills:** every kill (deadline, client gone, shutdown) goes through `kill_owned()` under that same lock, and only for an owned child whose `returncode is None`. An unreaped child is at worst a zombie, so its pid/pgid cannot have been reused. No integer snapshot is signalled after the lock is released. The closing gate before `Popen` is kept.
- **Workers:** registered **and started** under the lock. `shutdown()` returns every registered worker that was never started (`ident is None`) or is still alive; an empty list is the only success.

**Tests: 21 (r5's 18 + 3 regressions).**
- `tests/test_witness_producer_r6.py` (14) = r5's 11 (the shutdown test reads `Popen.pid`), plus:
  - `a_reaped_fetch_is_never_signalled_even_while_its_stderr_is_still_open`: a grandchild holds stderr after the fetcher is reaped. The window (`procs` empty, slot still active) is **observed**; `shutdown()` then makes **no** `killpg` call (recorded by a stub that signals nothing) and the fetch is still served.
  - `shutdown_never_reports_success_with_a_registered_unstarted_worker`.
  - `admitted_workers_are_started_while_the_admission_lock_is_held`.
- `tests/test_forward_chain_r6.py` (7) = r5's forward suite, on the r6 producer.

**`jobs/tests.sh`:** exact counts 14 + 7, the r1-r5 sums, the bridge source pin and no orphaned fixture processes.
