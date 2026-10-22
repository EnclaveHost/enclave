# sia-s3 storage safety: B2/B3/L1 validated natively; B4 (durable version-range ceilings) designed, implemented and validated (2026-10-20)

**Worktree:** `work/storage-safety-review/sia-s3` (baseline `54818ba`, uncommitted).

**Baseline proof copy:** `work/storage-safety-review/baseline-proof/sia-s3`. It holds the `54818ba` sources, the new
tests and observation-only shims. It is not the active writer's source and is not used for anything else.

**Not done:** no commits, pushes, production access, SSH, chain, Wine or GUI. No release WASM build (held until all
storage fixes are integrated, as instructed). No edits to the membership worker's companion
(`enclave-apps-sia-recovery`).

**What this is not:** these are local results on a mock indexer and mock hosts. They are not proof of decentralization,
or of behaviour against a real indexd.

## How the runs were bounded

- **Isolated target directory.** `target/` inside my worktree, first filled with a copy of the other worktree's native
  `debug` trees (`target/debug`, `target/x86_64-unknown-linux-gnu/debug`).
  - The copy was checked afterwards: **0 files** in the source cache changed during it, so it is a consistent snapshot.
  - The source cache was never written to.
  - Only the vendored path crates and `sia-s3` recompiled; registry dependencies came from the copy.
- **One job at a time** through `work/storage-safety-review/logs/run-bounded.sh`:
  - its own `systemd-run --user --scope` with `MemoryMax=1024M`, `MemorySwapMax=0` and `CARGO_BUILD_JOBS=1`;
  - `--test-threads=1`;
  - a 1 s watchdog that stops **only that scope** if host `MemAvailable` falls below 16 GiB, and records the scope's
    cgroup `memory.peak` and `oom_kill` count.
- **The watchdog fired once.** In the first B4 full-suite attempt (`full-suite-b4b.log`) host `MemAvailable` reached
  16,762,200 kB, just under the 16,777,216 kB floor, and my scope was stopped (exit 143). I waited until about 18.1 GiB
  was available and reran.
- **What "peak" measures.** Peaks are cgroup `memory.peak`, which includes page cache, so it is an upper bound on RSS,
  not pure RSS.
  - Compiles of the `sia-s3` test binary peaked at 847 to 1024 MiB. Three runs that included a recompile reached the
    1024 MiB cap and were reclaimed, with **0 OOM kills**.
  - Test-only runs peaked well below the cap.
  - Two short tests show `peak_MiB=0` because they finished before the first 1 s sample, so they were not measured.
- **Command form.** libtest takes ONE filter: each focused test was run separately, or the whole suite once. All logs
  are in `work/storage-safety-review/logs/`.

## Results (all run; nothing below is a claim from an unrun test)

| Run | Result | Peak | Log |
| --- | --- | --- | --- |
| Test build with B2/B3/L1 (vendored crates and sia-s3 compiled) | ok, 0 warnings in edited files | 931 MiB | `build-tests.log` |
| **Full native suite with B2/B3/L1** | **42/42 passed**, 31.3 s | 979 MiB | `full-suite.log` |
| Baseline copy build | ok | 917 MiB | `baseline-build.log` |
| 4 new B2/B3 regressions on the baseline | **all 4 FAILED** (expected) | 0 to 288 MiB | `baseline-<test>.log` |
| 3 baseline probes (bug present) | **3/3 passed** = bug demonstrated | 254 MiB | `baseline-probes.log` |
| B4 builds | ok, 0 warnings (final) | 847 to 1024 MiB | `b4-build*.log` |
| B4 tests, each alone (after one fix, below) | 3/3 passed | 270 to 1024 MiB* | `b4r-*.log` |
| Full suite with B4, first attempt | 42 passed, 3 existing tests failed | 973 MiB | `full-suite-b4.log` |
| Full suite with B4, watchdog stop | stopped at the host floor (not a test result) | 1010 MiB | `full-suite-b4b.log` |
| **Full native suite with B4 (final)** | **45/45 passed**, 35.9 s | 976 MiB | `full-suite-b4c.log` |
| B4 baseline probe | passed = an acknowledged DELETE is undone at `54818ba` | 1024 MiB* | `baseline-b4-probe.log` |

\* These runs included a recompile in the same scope.

All tests use the real SDK path: encryption, erasure coding and sector-root proofs. New tests use the disk-backed mock
sectors (`Net::on_disk`).

## B2, B3 and L1: proof scope

**The regressions FAIL on `54818ba`, each at its behavioural assertion.**

- **`an_unreadable_manifest_of_a_live_version_keeps_the_replica_unloaded`** panics at "a replica must not load without
  the manifest of a live version": the baseline load succeeded.
- **`a_re_read_never_swaps_out_a_pin_still_in_flight`** panics at "no swap while a pin is in flight": the baseline
  swapped.
- **`a_re_read_never_waits_on_a_busy_index_while_holding_the_write_lock`** panics with `Elapsed`: the baseline reconcile
  waited past 20 s holding the write lock.
- **`a_replaced_store_sends_nothing_more`** panics at `unwrap_err()` on `Ok`: the baseline's old `Rc` wrote a ledger.

**They PASS with the fix.**

**Positive probes PASS on `54818ba`, so each bug is concretely there:**

- **`baseline_probe_live_manifest_unreadable_serves_stale_bytes`:** the replica loaded without its live manifest and
  served `"old bytes"` for an acknowledged overwrite.
- **`baseline_probe_in_flight_swap_loses_the_part`:** the swap happened with a pin in flight, the fresh index was not
  dirty, and `CompleteMultipartUpload` failed with `InvalidPart` for a part the indexer holds.
- **`baseline_probe_replaced_store_reaches_the_indexer`:** after a swap, the old `Rc`'s ledger reached the indexer, and
  the current index did not know it.

**Shims in the baseline copy, all observation-only:**

- `in_flight()`: a counter around `remote()`'s existing await;
- `is_retired()`: always false.

No behaviour changed (shown by `diff` against `54818ba`). The dead-manifest preservation test was not run on the
baseline, because it needs the new `blocking_unresolved()` API.

**Not covered by a test:**

- L1 against a real reqwest error. It is unit-tested on reqwest-shaped strings and through `e2s`.
- Compaction racing reconcile directly. It is covered through the shared `remote()` gate, and through a held index
  standing in for the compactor's lock. The compactor's 300 s age cutoff makes direct compaction impractical in tests.

## B4: cross-writer ordering by durable version-range ceilings

The design was published first: `work/storage-clock-interface.txt`. A wall-clock margin is **not** used.

**Invariant**

- **I1:** a writer stamps a version only if it lies at or below a ceiling that writer has had **acknowledged on W
  replicas**.
- **I2:** a booting writer's clock floor is at or above the highest ceiling on its loaded boot set, and every version it
  stamps is strictly above it.

With fail-stop, durable acknowledgements, any W set meets any N−W+1 boot set. So every version an earlier writer
stamped, acknowledged or abandoned, is below the new writer's first version and below any DELETE floor it writes,
whatever the clocks say.

**Implementation** (store.rs +51, replica.rs about +130 non-test, main.rs a log line):

- **Record (`store.rs`):**
  - `Meta.ck: Option<u64>`: a ceiling object is a 1-byte object whose signed, sealed metadata holds the ceiling. There
    is no body to read at load.
  - It is **append-only**. A late pin of an old reservation can only add a ceiling, never lower one; in-place re-pins
    were rejected for exactly that reason.
  - Once a replica pins a ceiling, its lower ceiling objects are deleted, leaving one per replica at steady state.
  - `Index.ceiling` and `Index.ceilings`; never an orphan (`purposeful`, and excluded at `build_index`).
  - `Store::write_ceiling(c)` and `Store::ceiling()`.
- **Writer (`replica.rs`):**
  - `Cluster` state: `ceiling` (acknowledged by this process), `observed` (the highest loaded ceiling), a `reserving`
    mutex, and `range_ms` (6 h).
  - **`stamp()` replaces `tick()`** at all four stamping sites: PUT commit, copy, DELETE tombstone and multipart
    completion. It refuses (503, nothing written) above the acknowledged ceiling.
  - **`ensure_range()`** runs outside the write lock before those sites:
    - it reserves `max(now, clock, observed) + range` on every loaded replica;
    - it uses the range only after W acknowledgements.
  - **`rebuild()`** sets `observed` and moves the clock past any ceiling **above this writer's own acknowledged
    ceiling**. At boot, when the writer has none, that is every observed ceiling.
  - **Maintenance (`ceilings()`)** renews before half the range is used (only once this process writes), and copies the
    acknowledged ceiling to any loaded replica holding less.
  - **Status:** `version_ceiling`, `observed_ceiling` and `version_fence` ("legacy" until the first reservation, then
    "ceiling") in the cluster stats; `versionCeiling` per replica.

**A bug found and fixed during validation.** My first `rebuild()` raised the clock to *every* observed ceiling,
including this writer's own reservation. The clock then jumped to its own ceiling, the range was burnt, and every
maintenance pass reserved again: an upload per replica. The diagnostics are in `b4-debug.log`, which shows r1 at
exactly `ceiling + 6 h`. The fix is the "above own ceiling" rule. The regression is part of
`versions_are_stamped_only_inside_a_reserved_range`: after `rebuild()`, a write inside the range needs no new
reservation.

**B4 tests (pass):**

- **`an_old_writers_abandoned_write_stays_below_a_new_writers_delete_whatever_the_clocks_say`**
  - P1's clock runs one hour ahead. Its second PUT is stamped (+1 s) and held by `Fault::Defer`. P1 stops.
  - P2 (honest clock) observes exactly P1's acknowledged ceiling, and DELETEs with a tombstone version above it.
  - The indexer then applies the stale PUT. The key stays deleted on reload and after maintenance, and the stale
    version is purged (only the floor remains).
- **`versions_are_stamped_only_inside_a_reserved_range`**
  - There is no stamp before a reservation, and the fence reads "legacy" and then "ceiling".
  - No re-reservation happens inside the range, even after `rebuild()`.
  - An exhausted range refuses a stamp; the next write reserves strictly above it and stamps inside the new range.
  - There is one ceiling object per replica, never an orphan.
- **`a_lagging_replica_gets_the_ceiling_and_a_late_reservation_only_raises_it`**
  - A replica offline during the reservation gets the ceiling from maintenance.
  - A reservation answered nowhere in time fails the write and stamps nothing. Applied late, it only raises the next
    writer's floor: the next version and ceiling are strictly above it.

**Baseline proof:** `baseline_probe_skewed_old_writer_resurrects_a_delete` **passes on `54818ba`**. The same scenario
deterministically serves `"stale"` after an acknowledged DELETE: P2's tombstone was v1 + 1 ms, below the stale v1 +
1000 ms.

**Three existing tests had to change**, by precise and stated amounts. Nothing was suppressed.

- **`one_indexer_keeps_a_floor_and_reclaims_the_payload`** and
  **`many_part_uploads_and_long_keys_use_manifests_everywhere`** counted objects ("only ledgers remain"). They now
  assert exactly one ceiling object per replica, plus the same other objects.
- **`a_hung_replica_delays_a_quorum_write_by_the_grace_period_only`**, W=2 part. Its new cluster's first write now
  reserves, so the injected `pin_object` hang hit the **ceiling** pin.
  - The write still failed with 503 within the deadline, but before committing anything, so "r0 committed: visible"
    no longer held.
  - The test now makes one healthy write first, so the hang lands on the commit pin as the test intends. The comment
    records that a hang during reservation also yields 503, earlier and with nothing committed.

### B4 scope and limits (explicit)

- **Fenced:** every writer running this code against every earlier writer running this code, under fail-stop and
  durable acknowledgements, with **one writer at a time**. Concurrent writers are still unsupported: indexd has no
  fencing, and B4 orders consecutive writers.
- **Legacy transition (explicit, no false claim).**
  - A deployment with no ceilings boots as `version_fence: "legacy"`, and its first write reserves the first range.
  - Requests left in flight by a writer that ran **pre-B4** code were never bounded by a ceiling. They stay ordered only
    by wall clock, and B4 does **not** fence them.
  - The safe transition is to stop the pre-B4 writer and accept that window, or wait out its in-flight requests by
    operational means. The fault model allows "applied arbitrarily late", so nothing in code can prove them fenced.
- **Rollback** to pre-B4 0.2.0 makes its sweep treat ceiling objects as orphans after a day. Fencing is lost, not data.
- **Unfenced writer:** `sia-s3 import` (offline tool) stamps `SIAS3_IMPORT_VERSION_MS` or the wall clock without a
  reservation, so it must not run while any writer runs. It is not changed.
- **Cost and latency:**
  - one tiny upload per replica per reservation;
  - renewal every 3 h while writing;
  - **the first stamping write after a boot reserves inline.** That is an upload, measured in seconds on the mock and
    estimated at about 45 s per the live-network note in `REPLICATION.md`. It is unmeasured here.
  - A stamping write also reserves inline if the wall clock jumps past the range. That gives 503 if W acks cannot be
    had.
- **Membership joint points (not implemented here; the membership logic is not edited):**
  - **M1:** reservation acknowledgements must be counted among the acting membership's voters (today: `loaded()`).
  - **M2:** the membership commit or admission precondition must require `store.ceiling() >= cluster.observed_ceiling()`.
    B4's maintenance copy provides that, and the membership barrier must check it.
  - **M3:** `observed` is a maximum over all loaded replicas, which is only safer than any read set.

  Without M1 and M2, B4 holds for a stable membership; across membership changes it holds once the barrier carries the
  ceiling. B1 is already unsafe until the membership fix lands. I did not invent a partial joint protocol.

## Source overlap with the membership worker (for the coordinator's merge)

| File | My change | Membership interface (`storage-membership-interface.txt`) |
| --- | --- | --- |
| `store.rs` `Meta` | new field `ck` | new field `ms`: adjacent fields; both are added to `purposeful()` |
| `store.rs` `build_index` | excludes `ck` objects from orphans; computes `ceiling` | `ms` records need the same exclusion |
| `store.rs` `Store` | `retired`, `inflight`, `InFlight`, `RETIRED`; `remote()` gate; `blocking_unresolved`; `redact`; `write_ceiling`/`ceiling` | records are written via `pin_with` → they are gated by retirement too (intended) |
| `replica.rs` `Cluster` | fields `ceiling`, `observed`, `reserving`, `range_ms`; `stamp`/`ensure_range`; `rebuild` lines; `reconcile` rewrite; `note` redaction; `repair()` calls `ceilings()`; `replica_status` field; `RepairReport.ceilings`; `ClusterStats` fields | membership state recomputed in attach/reconcile/rebuild, voting predicate, commit in maintenance. **`reconcile`** must carry any new per-replica state into `fresh` (step 4). **`ensure_range`** must use the voter predicate (M1). |
| `main.rs` | boot error `redact`; repair log adds `ceilings` | none listed |

The B2/B3/L1 diff and the B4 diff are both in this worktree. They are separable by hunk:
- **B4:** the `ck`/ceiling/stamp/ensure_range/ceilings code, plus its three tests and the three adjusted tests.
- **B2/B3/L1:** everything else.

The worktree is uncommitted, so splitting is by hunk.

## Reproduce

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-safety-review/sia-s3
L=../logs/run-bounded.sh          # scope MemoryMax=1024M, no swap, jobs=1, 16 GiB host floor watchdog
$L full    cargo test --offline --target x86_64-unknown-linux-gnu -- --test-threads=1            # 45 expected
$L one     cargo test --offline --target x86_64-unknown-linux-gnu -- --test-threads=1 an_old_writers_abandoned_write
# baseline proof copy (54818ba sources, new tests, observation-only shims):
cd ../baseline-proof/sia-s3
$L probes  cargo test --offline --target x86_64-unknown-linux-gnu -- --test-threads=1 baseline_probe   # 4 pass = bugs present
```
