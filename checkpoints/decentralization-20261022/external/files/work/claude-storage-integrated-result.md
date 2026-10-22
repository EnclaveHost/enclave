# sia-s3: membership (B1) integrated with B2/B3/L1/B4, plus the protocol review's fixes (2026-10-19)

**Tree:** `work/enclave-apps-sia-recovery/sia-s3`. Base `54818ba`, uncommitted, awaiting coordinator review.

**Not done:** commits, production, indexd, SSH, chain, WASM release, catalog. No edits in the safety worktree
(`work/storage-safety-review/sia-s3`) or the audit snapshot (`work/storage-protocol-audit/snapshot`). Mutants ran
only in my isolated scratch copy, `work/storage-membership-mutants/sia-s3`.

**Not a certification.** These are mock-network results under the one-writer, fail-stop, durable-acknowledgement
model. They are not proof of real-indexd behaviour or of decentralization.

## 0. Provenance and preservation

**Before editing**, the main tree was captured in `work/storage-integration-snapshots/main-before-20261019T193238/`:
- `main-uncommitted.patch`: the exact `git diff --binary`;
- `main-tree.tar`: the full tree without `target`;
- `sha256.txt`;
- `git-state.txt`.

**The safety tree's diff was saved** as `work/storage-integration-snapshots/safety-review.patch`, with its hashes in
`safety-review-state.txt`.

**Checked after all work** (the commands are in section 5's log directory):

| Tree | Check | Result |
| --- | --- | --- |
| Safety worktree | `src/*.rs` hashes | identical |
| Safety worktree | `git diff` | byte-identical to the saved patch |
| Audit snapshot | `sha256sum -c SHA256SUMS` | 11/11 OK |

**Final hashes of the main tree:** `work/storage-integration-logs/final-sha256.txt`.

| File | sha256 (prefix) |
| --- | --- |
| `replica.rs` | `043d9ee4…` |
| `store.rs` | `225c09b4…` |
| `main.rs` | `ed6abf7f…` |
| `config.rs` | `0926f0cf…` (unchanged by this step) |
| `REPLICATION.md` | `e8ff4c1d…` |

`git diff --stat` against `54818ba`: 6 files, +2701 / −136.

## 1. What was integrated

### From the safety tree

**`store.rs`.** 12 of its 15 hunks applied cleanly with `patch`. The other 3 overlapped my `ms` field or my
repair-log line, and I merged them by hand. What came in:
- `Meta.ck`;
- `Index.ceilings` and `Index.ceiling`;
- `write_ceiling` and `ceiling`;
- B3's `retired`, `InFlight`, `RETIRED`, `retire`, `is_retired` and `in_flight`, and the `remote()` gate;
- L1's `redact`, and `e2s` redacting;
- B2's `blocking_unresolved` and the `fetch_index` refusal, plus `purge_dead` dropping dead unresolved manifests;
- compaction skipping `prune_slabs` on a retired store;
- the redaction test.

**Kept from my side:** `ms`, `unreadable_record` and the records.

**`Index::complete()` now uses B2's predicate:**
`unread_ledgers.is_empty() && blocking_unresolved().is_empty()`.

**`replica.rs`** (by hand):
- B3's `reconcile` taken wholesale. Its `rebuild()` also recomputes the membership state and the observed ceiling,
  so a re-read can reveal a late seal or admission.
- L1's `note()` redaction.
- B4:
  - `VERSION_RANGE_MS` and `STAMP_LOW_MS`;
  - the fields `ceiling`, `observed`, `reserving` and `range_ms`;
  - `stamp()` at the four stamping sites, with `ensure_range` before the write lock at each;
  - `ceilings()`, run in `repair` in the order floors → ceilings → admission;
  - the stats fields and `versionCeiling`.

**`main.rs`:** the boot-error `redact`, and ceilings in the repair log.

**Ported tests, verbatim:** B2 (2), B3 (3) and B4 (3). The three adjusted tests got their stated adjustments,
combined with my record counts. "Only ledgers remain" now reads `ledgers + records + 1 ceiling`; the hung-replica
test gets its warm-up write.

### Joint points (the handoff `work/storage-protocol-integration.txt`)

| Point | What the code does |
| --- | --- |
| **M1** | `ensure_range` pins the ceiling on every loaded replica, but counts `votes()`, the acting voters only, against `need()`. Its precheck is on `votes(loaded)`. A changed `acting` during the fan refuses the reservation. |
| **M2** | `caught_up` requires `idx.ceiling ≥ required`. Under the locks, `required = required_ceiling_now()`: the max of the process's own acknowledged ceiling, `observed`, and every loaded replica's `idx.ceiling`. That last part is fresh, read by `try_lock`. Every seal and admit record carries `c = required` (`MsRec.c`). `rebuild` folds records' `c` into `observed` (`Index::version_floor`). |
| **M2-live** | `ceilings()` copies `known_ceiling()` to every loaded replica whether or not this process reserved. It renews only when this process holds a range and is ready. |
| **RC** | `admission` takes `reserving`, then `write`, and holds both through its final rebuild. The lock order is reserving → write everywhere. |
| **M3** | `observed` is the max over **all** loaded replicas, from ceiling objects and from records. |

### Hardening found while integrating

Under the write lock, `admission` used `lock().await` on replica indexes. That is the stall B3 removed from
`reconcile`. Now:
- the final check uses `try_lock`, and a busy index means pending, retried next pass;
- a member with a remote call in flight is not admitted;
- seal counting under the lock uses `try_lock`.

**Residual:** `pin_record`'s index bookkeeping still awaits the index after its pin. That wait is bounded by the
holder's work (as in `write_ceiling`); it is not removed.

## 2. Review findings (`work/claude-storage-protocol-review-result.md`): what changed

| # | Fix | Test |
| --- | --- | --- |
| **P1** (record-less N>1 acknowledged writes a reverted list loses) | The record-less N>1 state is **never ready** (no voters). `MsState.finish` makes `main.rs`'s boot loop run maintenance, which commits the set once every listed replica is loaded. The old `pending()` was replaced by `finishing()`. | `a_deployment_without_records_migrates_only_with_every_indexer_up` (rewritten for this: a write is refused before the commit, and a reverted list waits); state-machine asserts |
| **P2** (record-less commit sealed nothing) | Every listed replica is sealed and all must succeed (`seal_needed = n`), also in Pending with `prev = None`. | state-machine P2 case: r0 holding only a seal is Waiting; without the seal it would be Legacy-ready; deployment test revert |
| **P3** (stale part variant passes the commit) | `caught_up` refuses while the sources hold two or more variants of an open part. `repair_parts` copies only a single agreed variant. | `a_change_waits_while_the_sources_disagree_about_an_open_part` (5 indexers: no commit, then completion under the old set, then commit, and the new set serves Y) |
| **P4(b)** (same-epoch split, permanent Refused) | Resolve rule: when every record at the top epoch names a previous set and exactly one set has admissions, that set acts. Otherwise Refused, and the reason points to the manual recovery. | state-machine resolve and refuse cases |
| **P4(a)** | Record-less N>1 sets commit as **epoch 2** (`RECORDLESS_SET_EPOCH`). A late single-indexer epoch-1 admit can then never collide. | state-machine (target epoch 2) |
| **P4, M4** (stamped epochs) | **Not adopted.** The review itself shows that variant reopening a lost write (S1). | — |
| **P5** | M1, M2 (fresh), M2-live, RC and M3, as in section 1. | below |
| **P6** | Seal-shortfall comment corrected. The Waiting reason names unlisted members and suggests `retiring`. "No rollback below this build" is documented (`54818ba` sweeps records and ceilings after a day). `complete()` uses B2's predicate. | — |

**Tests changed by these fixes (stated, not relaxed):**
- **Epoch numbers.** A record-less three-replica start now commits as epoch 2, so later changes are epoch 3.
- **`membership_repro_replacing_a_member_after_an_acknowledged_delete`** now commits its set first (`settle`) before
  acknowledging the DELETE. Under P1 a record-less set takes no writes. The assertion is unchanged, and the original
  54818ba failure remains in `work/storage-membership-repro.log`.
- **`an_interrupted_commit…`'s helper `backfill`** now includes the ceiling copy, as real maintenance does.
- **The skew test** waits 5 ms before its re-reads. `dirty()` is `ambiguous_ms >= listed_ms`, so a listing in the
  same millisecond as the abandoned pins is conservatively dirty. That was a test-timing artifact (diagnosed with a
  temporary print, since removed). It passed 3/3 alone after the change.
- **`Net::new` is now disk-backed.** In RAM, ceilings and records (full 4 MiB-sector slabs) pushed
  `a_hung_replica_delays_a_quorum_write_by_the_grace_period_only` into a cgroup OOM kill at 1 GiB: `full1.log`, exit
  143, and the journal's "oom-kill" for scope `sias3-integ-3318106-26235`. `Net::in_memory` keeps the in-memory
  store for `disk_and_memory_mock_sectors_answer_alike`. No assertion changed.

## 3. New adversarial integration tests (all pass)

**`a_reservation_counts_only_voting_replicas` (M1).**
- A member that lost its state is not a voter.
- With r1 down, the reservation reaches r0 (a voter) and r2 (not a voter): 503, ceiling 0, nothing stamped.
- The stray ceiling only raises the floor.
- After re-admission, r0 + r2 are enough.

**`a_migration_reserves_only_with_the_old_sets_voters` (T-M1).**
- {r0} → {r1, r2}, with r0 retiring and the only voter.
- r0's ceiling upload fails; r1 and r2 store it: refused, 0 votes, nothing stamped.
- Once r0 works again, a PUT succeeds.

**`a_commit_waits_for_the_ceiling_and_carries_it_past_a_skewed_old_writer` (M2, cross-writer across a migration).**
- P1's clock runs an hour ahead. Its reservation is acknowledged by r0 only, while r1 and r2 are down.
- A stale PUT is deferred on all three indexers.
- The ceiling copies fail by upload refusal (the replicas stay clean): **no commit**.
- The next pass copies the ceiling, commits, and the records carry `c ≥ P1's ceiling`.
- P2 boots from {r1, r2} alone: `observed ≥ P1's ceiling`, and its DELETE is above it.
- The deferred PUT then lands: the key stays deleted, and is purged down to the floor.

**`a_partially_sealed_change_refuses_writes_and_reservations_until_finished` (partial seal and crash).**
- 1 of 2 seals: Pending. PUT and `ensure_range` are refused.
- After a restart: still Pending, and `observed` still ≥ the old writer's ceiling.
- Maintenance finishes (2 seals + 3 admits).
- The new set serves with r0 gone and r1 down, and stamps above the old ceiling.

**`a_pending_change_copies_a_ceiling_only_the_old_set_holds` (M2-live).**
- Pending after a restart. This process has reserved nothing, and a higher ceiling (abandoned, then landed) sits on
  r0 only.
- Maintenance copies it to r1, r2 and r3, then finishes.

**`admission_waits_for_a_reservation_in_progress` (RC).**
- With `reserving` held, `settle` makes no progress in 3 s and changes nothing.
- Once released, it commits.

**`in_flight_parts_and_unreadable_manifests_hold_a_migration_back` (B3/B2 × membership, multipart, manifest).**
- A part's pin stays in flight on a new member during the commit attempt: no commit, and the part is acknowledged
  under the old voter.
- Applied, re-read and committed. The upload then completes, and the manifest key reads on the new set alone.
- A new member that cannot read a live manifest never loads or counts. The acting set keeps serving, and no commit
  happens.

**`a_returning_member_that_missed_a_delete_and_a_reservation_cannot_undo_either`.**
- A stale admitted member comes back.
- `observed` equals the missed writer's ceiling (from r1), the tombstone hides the stale version, and new stamps are
  above it.
- Maintenance applies the delete there.

**Plus the review regressions in section 2.**

## 4. Mutation probes (isolated scratch copy; restored and verified after each run)

**Logs:** `work/storage-integration-logs/mutants.log` and `mutants2.log`, with per-mutant logs `mut-*.log` and
`mut2-*.log`.

| Mutant | Killed by |
| --- | --- |
| MI1: a reservation counts non-voters | `a_reservation_counts_only_voting_replicas` |
| MI2a: no ceiling check in `caught_up` | the skew/M2 test |
| MI2b: records carry no ceiling | the skew/M2 test (its record assertion) |
| MI2c: no check and no carry | the skew/M2 test |
| **MI3: `observed` ignores the ceilings records carry** | **SURVIVED.** Expected: admission already requires the member's ceiling *object* ≥ the carried value, so record `c` is redundant evidence. Reported, not hidden. |
| MB3: swap with a call in flight | `a_re_read_never_swaps_out_a_pin_still_in_flight` |
| MB2: load without a live manifest | the B2 test and the migration B2 test |
| MB4: stamp without a range | 2 tests |
| MP1: a record-less set serves | 2 tests |
| MP2: a record-less commit seals none | 2 tests |
| MP3: any part variant accepted | the P3 test |
| MP4: no resolve | the state-machine test |
| MRC: admission without `reserving` | the RC test |
| MM2L: copy only this process's own ceiling | 9 tests |

## 5. Validation runs (exact)

**Runner:** `work/storage-integration-logs/run-bounded.sh`. Each run gets its own systemd scope:
- `MemoryMax=1024M`, `MemorySwapMax=0`, `CARGO_BUILD_JOBS=1`, one test thread;
- a 1 s watchdog that stops only its own scope below 16 GiB MemAvailable;
- `memory.peak` and `memory.events` recorded.

Only my main target and my scratch target were used, never concurrently.

| Run | MemAvailable at start | Result | Peak / events |
| --- | --- | --- | --- |
| `full1` (in-memory mock) | 18,054,304 kB | OOM kill during the hung-replica test (exit 143) | journal: oom-kill |
| `full2` (disk mock) | — | 55/56 (`backfill` lacked the ceiling copy) | oom 0 |
| `full3` / skew runs | — | fixed as stated in section 2 | oom 0 |
| `full4` | 17,967,200 kB | 61/61 | oom 0 |
| `full5` | — | 62/64 (the two test issues of section 2) | oom 0 |
| `full6` | 18,600,980 kB | **65/65** | oom 0 |
| **`final-a`** | 20,556,976 kB | **65/65**, 101.6 s | peak 1,073,741,824 (page cache at the cap), oom 0, oom_kill 0 |
| **`final-b`** | 20,208,668 kB | **65/65**, 98.1 s | peak 1,073,713,152, oom 0, oom_kill 0 |
| `final-wasm`: `cargo check --target wasm32-wasip2` | — | clean, 0 warnings | — |

- **The 65 tests:** the 36 at `54818ba`, my 11 membership tests, the 9 ported safety tests, 5 integration tests,
  and 4 review regressions.
- **What "peak" measures:** `memory.peak` includes the disk mock's page cache; the `max` events are reclaims, not
  OOMs. Anonymous memory alone was not measured.
- **Cleanup:** `target/mock-sectors/` is empty afterwards.

## 6. Guarantees and limits (honest scope)

**Model:** one writer, fail-stop, durable acknowledgements. Concurrent writers remain unsupported (indexd has no
fencing).

**B4 fencing scope:** it holds only between writers that both run this code. Requests left by pre-B4 writers are
ordered by wall clock only, and `version_fence` reads "legacy" until the first reservation.

**Real costs**
- **A record-less replicated deployment** does not serve until it is backfilled and committed. Recording a single
  indexer first avoids that downtime.
- **Migration availability:**
  - the old set's rules apply until the commit;
  - the commit needs every new member reachable;
  - an ambiguous multipart part holds the commit until that upload is completed or aborted.
- **Same-epoch splits** that the resolve rule cannot decide stay Refused. Recovery is manual: delete a stray record
  after checking. That is documented, and no tool exists.
- **No rollback below this build:** older 0.2 builds sweep records and ceilings after a day.

**Not done**
- The optional part order (`PartTag.h`, a fifth `stamp()` site).
- M4.
- A real-indexd validation.
- A release build.

## 7. Files

**Changed in the main tree:**
- `src/store.rs`, `src/replica.rs`, `src/main.rs`, `REPLICATION.md`, `README.md`;
- `src/config.rs`: from the membership step only.

**Coordination:** `work/storage-membership-interface.txt`, section 4 appended.

**Logs:** `work/storage-integration-logs/`.
