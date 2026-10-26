# Witness r6: owned fetch children and race-free shutdown (root 1616 review). Source only; nothing run, built or installed - 2026-10-26

## Stage: `witness-producer-service-stage/r6`, FROZEN
**`SHA256SUMS` = `6851047d8b059ada42847a469cf497776aa2ec3b0083f545bd1d7ae9b3ba928c`** (hashed with `sha256sum`; files `a-w`).

| file | sha256 |
|---|---|
| `producer/witness_producer.py` | `1fc2ea3266c7b9cda1619f83d8603ea25aa6232075c769bc386b2b18eb0d4d14` |
| `tests/test_witness_producer_r6.py` (14 tests) | `4a01330538ea5475bd6aeba8c3deab94b55d79347161bb4467289dfe2b2cdda2` |
| `tests/test_forward_chain_r6.py` (7 tests; byte-identical to r5's, it imports its own stage's producer) | `62ee60268583617393134d4d16bc95fe5998eab30b0a381b4868a10fd2bbfc08` |
| `jobs/tests.sh` | `ab5a1e231467559c04af7b3b4190f7e86a3df467d4d7b08a73576254de5daa17` |
| `README.md` | `8e7be41bb6dbf5cf9f3f01f6632c367cfa550638ad82019b0e8550231afef3c5` |

**Unchanged (re-verified):** r5 `a3bcefed…`. The job also re-verifies r1 `1efa5c85…`, r2 `07084e7a…`, r3 `816417f4…` and r4 `eef30b11…`.

## Root 1616's two races (confirmed in r5 source) → the minimal r6 fix
1. **PID reuse.**
   - **In r5:** `run_fetch` reaped with `p.poll()`/`p.wait()` without the lock, then `reader.join(5)`, and only then `procs.discard(pid)`. `shutdown()` copied the integer pgids under `cv`, released the lock, and called `killpg`. A reaped and reused pid/pgid could therefore be signalled.
   - **In r6, one ownership lock (`cv`) covers it all:**
     - `procs` holds the `Popen` objects;
     - the **only** reap is `p.poll()` inside `with self.cv`, and it unregisters (`procs.discard(p)`) **in the same critical section**;
     - there is no `p.wait()` any more: after a deadline or client-gone kill, the loop keeps polling under the lock until reaped;
     - **every** kill goes through `kill_owned()`, called with `cv` held (from `shutdown()` and from `run_fetch`), and only for an owned child whose `returncode is None`.
   - **Why that is safe:** an unreaped child is at worst a zombie, so its pid/pgid cannot have been reused. No integer is signalled outside the lock.
   - **Audit:** a grep shows a single `os.killpg` site (inside `kill_owned`), `procs.add(p)` under the closing gate before `Popen` (kept), one `procs.discard(p)` (with the reap), and no `p.wait()`.
   - **Assumption** (stated, not tested): nothing else in the process reaps the child. CPython's `subprocess._cleanup()` polls only `Popen` objects that were garbage-collected while running; ours stays referenced in `procs` until reaped.
2. **Worker registration vs start.**
   - **In r5:** a worker was added to `workers` under the lock but started after releasing it. `shutdown()` skipped `ident is None` and could return `[]` before `start()`.
   - **In r6:** the worker is registered **and started** inside the same `with self.cv`. `shutdown()` returns every registered worker with `ident is None` **or** `is_alive()`; an empty list is the only success.

## Regressions (3 new; r5's 18 unchanged except the shutdown test reading `Popen.pid`; no assertion weakened; no real signal sent)
1. **`test_a_reaped_fetch_is_never_signalled_even_while_its_stderr_is_still_open`:**
   - the fake fetcher starts a grandchild (`/usr/bin/sleep 4`) that inherits its stderr, writes the output and exits;
   - the test **observes** the exact r5 race window: the grandchild logged, `procs` empty (reaped and unregistered), the slot still `active == 1` (the handler waits for stderr EOF);
   - then it calls `shutdown()`. `os.killpg` is replaced by a **recorder that signals nothing**;
   - the assertions: `shutdown() == []`, **no `killpg` call at all** (r5 would have signalled the stale pgid), and the completed fetch is still served with 200.
2. **`test_shutdown_never_reports_success_with_a_registered_unstarted_worker`:** a registered, never-started worker makes `shutdown()` return its name (r5 returned `[]`).
3. **`test_admitted_workers_are_started_while_the_admission_lock_is_held`:** `Thread.start` is wrapped to record `lock.locked()`. A served (400) request's handler is started with the admission lock held (`[True]`), and `workers` is empty after completion.

Plus the existing real-kill path (`Shutdown` from r5): a running real fetch child is killed through `kill_owned` under the lock, its handler is joined, the client gets 502, and no orphan is left.

## Exact root job
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh witness-producer-r6 512 unshare -Urn bash witness-producer-service-stage/r6/jobs/tests.sh
```
**PASS requires all of:**
- `## test_witness_producer_r6 PASS (14)`;
- `## test_forward_chain_r6 PASS (7)`;
- no skips, no orphaned fixture processes, and `## witness-producer-r6 rc=0`.

Exit 9 is a PRETEST refusal naming the input: the r1-r5 sums, the bridge source pin, a tool (now also `/usr/bin/sleep`), or the manifest.

**Not claimed:** the race fixes are not shown to pass until this job passes.

**Unchanged measured-remaining list:**
- real witness sizes/durations;
- the Rust fetcher under `--fsize`;
- bridge method coverage;
- the QEMU path across both VMs;
- systemd `IPAddressAllow`;
- native acceptance;
- the release build/pin;
- the transport patch's node tests.
