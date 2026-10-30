# 1811: independent source-only review of composite-memory-fixture-stage/r1 (Claude50 1810). NO tests have run; nothing is PASS

**Scope:** reading only.
- **What I read:** the 1810 report; the stage's `memory_fixture.py`, `walker.py`, the tests and the three jobs; the reused r6 `composite_session.py` (Session, cleanup, `deferred`); the r9 helpers; and the queue's lane semantics.
- **Not done:** tests, probes, builds, mounts, scope changes, production I/O or edits. The stage is unchanged.

**Queue order:** the pending KVM 1024 build and 4096 test take the main lane first. No new jobs.

| item | sha256 |
|---|---|
| stage `SHA256SUMS` (7 entries, `sha256sum -c` OK) | `d888cfef12360c0f00c74170a984a7257504071b150d4f170cbbdc72cf1d15f5` |
| `memory_fixture.py` (521 lines) | `c0eb2e97fd10681a235a59e5927fe6301c88331f6ee588ea4dce7409b186a724` |
| `walker.py` | `bb01105dc8de7ba496f4fb67abfd5c73038b07b90d1844786adbc253c72a4113` |
| `tests/test_memory_fixture.py` (7) | `1a2af19e0ba6c781a89b683feb8479423da4fce75f7a0f3075b5c145e507b2a7` |
| `jobs/run-fixture.sh` / `tests.sh` / `common.sh` | `05c88e7a…` / `519ab99b…` / `201cf419…` |
| reused r6 runtime (pinned in the code) | `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6` |

## P1: fix before running the fixture
**F1. Total elapsed time and main-lane occupancy are NOT bounded.** The "900 s budget" bounds only the walker's scheduling (walker limit = deadline − now − 120 s; controller hard stop at limit + 10 s). Nothing bounds what happens after.
- **No cleanup deadline.** r6 `cleanup()` is per-step bounded but not in total. In the worst case:
  - the exec group (≈5 + 5 + 5 s);
  - `fusermount3 -u` (30 s timeout), then nbdfuse `stop_group` (≈15 s), then a lazy unmount (30 s);
  - qemu-nbd (≈15 s);
  - plus `reap_adopted` and the `holders()` /proc scan.

  That is roughly 2–3 minutes, more than the ≤ 110 s left before the 900 s mark. An unmount or FUSE request stuck in D-state can block indefinitely.
- **The job timeout cannot rescue a hang.** `jobs/run-fixture.sh` uses `timeout -s TERM 1200` **without `-k`**, and the controller sets **SIG_IGN during cleanup**. A cleanup hang therefore holds the **exclusive main flock** indefinitely, which **blocks every preservation copy/verify job**.
- **Minimal correction (choose and document one):**
  - **(a)** give cleanup a wall-clock deadline: still owned and ordered, but on expiry record CLEANUP-INCOMPLETE and return;
  - **(b)** use `timeout -s TERM -k <grace> 1200` and accept the consequence. If the controller is SIGKILLed, its servers end by PDEATHSIG only and a dead FUSE mount may remain. That is fail-closed and visible in `mounts-left.txt`.
- **Either way:** state the true worst-case main-lane hold time in the README and report, and remove the claim "exact elapsed ≤ budget".

## P2: fix or document before relying on a result
**F2. The reservation counts record existence, not r3-validated commits, and omits the fixture's own writes.**
- **The current rule:** `remaining = Σ length(root parts without a commit-record file)` (`prepare`, line 287), compared with free ≥ remaining + 40 GiB floor + 8 GiB root reservation + 80 MiB.
- **Under-reservation:** a part with a record but a missing, short, stale or replaced file (not r3-committed) is excluded from `remaining`, although re-preserving it needs up to 4 GiB.
- **Over-reservation (safe):** partials without a record are counted in full, though partly allocated already.
- **The fixture's own worst-case writes are not budgeted:**
  - the image (≤ 64 MiB enforced only before and after the run);
  - `qemu-nbd.log`, `nbdfuse.log` and `exec.log` (each up to RLIMIT_FSIZE 64 MiB);
  - the private walker copy and the receipts (≤ 460 samples).

  That totals ≈ 0.3 GiB against an 80 MiB term, so the excess comes out of the **8 GiB native-build reservation**, which belongs to another consumer.
- **Why this is not a data-loss blocker:** under the exclusive main lane no copy runs during the fixture, and the excess is ≤ ~0.3 GiB against an 8 GiB reserve.
- **Correction:**
  - reuse the established runner 1773 rule (count EVERY part not r3-validated committed in full, via its `part_state`, as 1804/1773 do);
  - add an explicit fixture write bound (image cap + 3 × 64 MiB logs + receipt bound) to `need` instead of drawing on the 8 GiB reservation.

**F3. `MemoryHigh` throttles the WHOLE queue scope, including the outer safety guard and the servers.**
- **What is in the scope:** the transient scope contains the queue's node `memory-guard` (the 768 MiB tree-RSS killer), the job bash, the controller, qemu-nbd, nbdfuse and the walker.
- **What happens above 512 MiB:** every allocating task in the scope is throttled (up to seconds per allocation). That can:
  - **(i)** delay the outer guard's own sampling and kill, the safety net, which pushes failures toward the scope `memory.max` OOM with an arbitrary victim (limit 2, now more likely);
  - **(ii)** throttle nbdfuse and qemu-nbd while the walker waits on them (priority inversion), making TIMEOUT likely.
- **Fixing it would need delegation:** a sub-cgroup for the walker is not available in a non-delegated scope.
- **Minimum:** add both effects to the LIMITS and the receipt. A MEASURED result describes whole-scope throttling, not walker-only reclaim.

**F4. The tests miss the paths that matter most.**
- **Cancellation:** test 6 calls `stop_group` and then `cleanup()` directly. It does **not** exercise the actual cancellation path, namely:
  - Stop raised in `use()`'s loop;
  - `interrupted` recorded;
  - SIG_IGN during cleanup;
  - the receipt name (`receipt.json` vs `receipt-refused-*`);
  - `outcome` → CANCELLED.
- **Soft stop:** the soft-stop branch of `use()` (stop_group with grace 0, then the result parse) is untested.
- **Reservation:** test 2 checks only arithmetic. Nothing tests how `remaining` is derived from records (F2).
- **Smallest meaningful additions:**
  - a unit test of `main()`'s finally/outcome path, with a stub session that raises `C.Stop` mid-`use()`;
  - a pure test of the remaining-bytes derivation over a fake target dir (record without file, file without record, valid commit).

  No new framework is needed.
- **The 1810 report's own "unproven" list stands:** set-property on the queue scope, FUSE charging, and fault speed.

**F5. Likely outcome expectation: SOFT-STOP before MEASURED.**
- The soft stop trips at tree VmRSS > 640 MiB.
- That sum includes the walker's mapped RSS (allowed to reach about 512 MiB before reclaim acts; high is not a ceiling) **plus** node, controller, qemu-nbd and nbdfuse (roughly 100–150 MiB).
- The margin is about 0–30 MiB, so SOFT-STOP (rc 6) is a probable result. That is honest, not a failure, but the README should say MEASURED is not the expected default.

## P3: minor or confirmations
- **F6, sampling cost:** `sample()` reads the walker's `smaps_rollup` every 2 s, which walks an 8 GiB mapping under `mmap_lock` and contends with the walker's faults. The hard stop is checked only once per loop iteration, after `sample()` returns, so a slow read delays it. Consider dropping Pss or reading it less often.
- **F7, the walker's own limit:** checked only every 65,536 pages (256 MiB). The controller's hard stop covers a stalled fault.

**Confirmed sound (by reading):**
- **Scope binding:** exactly one cgroup line; this uid's run-*.scope; `memory.max` = 768 MiB; the tree root is an ancestor in the same cgroup; `systemctl show ControlGroup` == our cgroup **before** `set-property`; `memory.high` was `max`. After it: own high = 512 MiB, own max unchanged, the **parent's high unchanged**, systemd agrees, and we are still in `cgroup.procs`.
- **Own-only:** set-property targets only our unit; `--runtime` dies with the scope.
- **Reuse compatibility with r6:**
  - the walker child is named **`exec`**, so r6 `cleanup()` ends it FIRST (r9 F1 order);
  - `PI=None` is never used, because `held()` is not called;
  - `a.fixture_unmount_exe=None` and `a.expect_kind` are set;
  - both r6 `Refused` and the fixture's `Refused` are caught;
  - the reaped-leader branch of `stop_group` never signals.
- **Partial setup:** the run claim, the work-dir claim, the image creation (+ inode), the walker copy, spawn and pidfd are all under r6 `deferred()`. Cleanup runs only for an owned work dir.
- **Image cleanup:** the image is unlinked only after a COMPLETE cleanup and only if it is the same inode. A late allocation over the cap turns the outcome into FAILED.
- **Read-only exposure:** qemu-nbd holds the image `O_RDONLY` (fdinfo); the mount is ST_RDONLY, the size exact, `O_WRONLY` refused.
- **Outcome honesty:** CLEANUP-INCOMPLETE > CANCELLED > REFUSED/FAILED > SOFT-STOP > TIMEOUT > walk checks > INCONCLUSIVE (no high event) > MEASURED; it never overclaims.
- **Queue use:** the 768 and 512 lanes are supported; 768 ≥ 512, so it is exclusive with preservation jobs. No queue or driver change.

## Recommendation
**Do not run `cmf-r1-run` until F1 is fixed.** Then fix F2–F4 or explicitly accept them in a new frozen revision.

`cmf-r1-tests` (512, no FUSE) is harmless to run, but it does not cover F4's paths. **No PASS of any kind exists for this stage.**
