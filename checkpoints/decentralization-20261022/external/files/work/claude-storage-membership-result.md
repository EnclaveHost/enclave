# sia-s3 membership and migration safety: result (worker 6b7af721, 2026-10-19)

**Repository:** `work/enclave-apps-sia-recovery/sia-s3`. Base `54818ba`, clean before this work. The changes are
**uncommitted**, awaiting coordinator review.

**Design and coordination notes:** `work/storage-membership-interface.txt`. It holds the reproduction and design,
written before the fix, plus the interfaces at the end.

**Not done:** commits, production activation, CLI or catalog publishing, SSH, chain, Wine, GUI, other repos, or any
mutation of the shared source. Mutants ran only in an isolated copy, `work/storage-membership-mutants/`.

## 1. Reproduction (before any fix, on 54818ba code)

All runs: native mock, disk-backed sectors, real SDK crypto and sector proofs, `MemoryMax=1024M`, `MemorySwapMax=0`,
1 build job, 1 test thread. Log: `work/storage-membership-repro.log`. All three failed.

| Test | Scenario | Result on 54818ba |
| --- | --- | --- |
| `membership_repro_two_empty_indexers_and_the_old_one_offline` | N=1 deployment acknowledges `PUT live`, plus a PUT and DELETE of `gone`. The config becomes N=3, W=2 with two empty indexers, and the old one is offline. | `ready=true loaded=2 live=None`: the empty view is served |
| `membership_repro_replacing_a_member_after_an_acknowledged_delete` | {r0, r1, r2}, W=2. DELETE k is acknowledged while r2 is down. r0 is replaced by an empty r3, and r1 is offline at the restart. | `ready=true k=Some(..)`: the acknowledged DELETE is undone |
| `membership_repro_open_multipart_upload_after_backfill` | An open upload with an acknowledged part on the old indexer. Migrate, run maintenance (2 copies, `pending 0`), retire the old indexer. | `complete_upload = Err("NoSuchUpload")`: an acknowledged part is lost |

## 2. Design: a durable membership barrier, not a relabel

Readiness used to count any loaded replica. Quorum intersection only covers writes acknowledged by W members **of the
current set**. The fix makes the replica set itself durable state, kept on the replicas.

**Membership records** (`store.rs` `MsRec`):
- A record is a one-byte object whose signed, sealed metadata names `{epoch, W, members}` plus the set it replaced.
- Members are identified by 64 bits of SHA-256 of each canonical URL.
- Records are add-only; they are never rewritten in place. That matters because object ids hash the slabs, so a pin
  applied late cannot overwrite a newer record.
- A record that cannot be parsed makes `fetch_index` refuse the load (fail closed).
- Sweep, compaction and parts handling never touch records.
- 0.1.x ignores them, as it does other v2 objects.
- There are two kinds:
  - `admit`: this replica held the complete history when this set admitted it.
  - `seal`: this replica's old set was replaced at this epoch.

**State machine** (`Cluster::membership`, a pure function of the loaded replicas' records; recomputed on every
attach, reconcile and rebuild):

| State | When | Ready? | Who votes |
| --- | --- | --- | --- |
| Legacy, single | No records, config N=1 | Yes, as today | The one indexer |
| Legacy, several | No records, N > 1 | Only when **every** configured indexer is loaded | All of them |
| Stable | Newest epoch is the configured set, with ≥ N-W+1 admitted members loaded | Yes | Admitted members only |
| Migrating | Another set is admitted at the newest epoch | Under that old set's N-W+1 | Old set's admitted members, with old W |
| Pending | Configured set was sealed but never had N-W+1 admissions | No; maintenance finishes the change first | Nobody |
| Waiting | Admitted members that are not loaded could hold what serving needs | No | Nobody |
| Refused | Records disagree, or a sealed change targets a different set than the configured one | No | Nobody |

**Admission (caught up).** A replica is admitted only if:
- it is not dirty;
- every manifest and ledger it holds has been read;
- it holds every view key at the view's version, every deletion (tombstone or floor), and every open multipart part
  the sources hold.

The view itself must be complete: N-W+1 admitted sources, each with every manifest and ledger read.

**New members** receive client writes (PUT, DELETE, parts) and backfill: keys, floors, and open multipart parts,
which repair could not copy before. They do not vote until admitted.

**Commit**, run by maintenance under the write lock:
1. Record bodies are uploaded first, outside the lock.
2. Under the lock, the state and every member are re-checked.
3. `seal` records are pinned on the old set's configured members. At least W(old) must succeed, or the change stays
   Pending and is retried.
4. `admit` records are pinned on every configured member.

**Why this is safe:**
- Every N-W+1 set of old members meets a seal, so the old set never serves again, not even after a config revert.
- A set that never reached N-W+1 admissions never acknowledged a write. A commit interrupted at any point can
  therefore be finished, at the next pass or at the next boot, before anything is served.

**UploadPart** is counted under the write lock. A part whose upload straddles a commit is refused with a retryable 503.

**A single-indexer deployment** writes one `admit` record at its first maintenance pass. A later migration away from it
can then keep serving from the old indexer alone while the new indexers backfill.

**`"retiring": true`** in the config lists a departing replica as a source and seal holder that is not a member.
`writeQuorum` counts members only.

## 3. Files changed (uncommitted)

**`src/store.rs`**
- `MsDef`, `MsRec`, `member_id`.
- `Meta.ms`, `Index.records`, `Index::complete()`, `Index::newest_record()`.
- `Store::upload_record`, `pin_record` and `adopt_part`.
- In `fetch_index`, an unreadable record refuses the load.
- Records are never orphans.

**`src/replica.rs`**
- Membership module docs.
- `Phase`, `MsState`, `Cluster.ms`, `membership()`.
- Voter-only quorum counting on every write path, `targets()` and `backfill_targets()`.
- A DELETE refuses up front without a voting quorum, so it writes no stray tombstones.
- `repair_parts`, `source_parts` and `copy_part` (MD5 and size checked).
- `caught_up`, `view_complete`, `admission` and `admissible`.
- `fan_out` takes `success(i, r)`.
- `Cluster::new((name, url, retiring), …)`.
- `RepairReport.{parts, admitted}`.
- Per-replica `/healthz` fields: `retiring`, `membership{phase, ready, epoch, target, reason}`, `voting` and `record`.

**`src/config.rs`**
- The `retiring` flag. W is validated against members.
- A config where every replica is retiring is refused, as is a non-boolean `retiring`.
- Tests.

**`src/main.rs`**
- While the state is Pending, boot runs maintenance before serving.
- Boot errors carry the membership reason.
- The repair log includes parts and records.
- `src/s3.rs` is untouched; its existing `readQuorum` now means the configured members' N-W+1.

**`REPLICATION.md`**
- A new "Membership changes" section: records, states, commit, what a change needs, and costs.
- Updated guarantees, the N/W table, activation step 6, operator procedures (1→3 migration, add, replace or remove
  via `retiring`, do not revert) and the validation list.

**`README.md`:** config line.

**Tests:** existing assertions changed only where record objects now exist. `objs.len()` now counts
`ledgers + records`, and the single-indexer test expects its record object. No existing test was removed or weakened.

## 4. New tests (11)

**Config**
- `retiring_replicas_are_listed_but_not_members`.
- `unsafe_replica_sets_are_refused`, extended with three new invalid configs.

**Store**
- `membership_records_fit_in_metadata_and_are_never_swept`: 16 replacing 16 still fits the metadata budget, records
  are never orphans, and an unreadable record is refused.

**Replica: the three reproductions above**, which now pass.

**Replica: `a_deployment_without_records_migrates_only_with_every_indexer_up`**
- With each of the three indexers down in turn, the cluster is not ready and PUT and DELETE are refused. The refused
  DELETE recorded nothing.
- With all three up, it serves. A write made during the migration is kept, the commit happens at epoch 1, and after
  the old indexer leaves the new ones serve everything, the delete holds, and floors are present.

**Replica: `a_recorded_single_indexer_keeps_serving_while_new_members_are_backfilled`**
- The reported case: the old indexer is offline, so the cluster is not ready.
- The old indexer alone serves and writes under its own rules, and nothing commits without the new members.
- With everyone up, new members are not voters. The commit writes 1 seal and 3 admits. With the old indexer then
  gone, everything is served, and stable availability holds: a write succeeds with one indexer down.

**Replica: `replacing_a_member_keeps_an_acknowledged_delete_and_the_old_set_never_serves_again`**
- Waiting while the old set may still be serving elsewhere.
- Migrating under the old rules, then the commit (2 seals, 3 admits).
- The deletion holds on the new members with r1 down.
- Reverting the list waits; it does not resurrect anything.

**Replica: `a_retiring_replica_hands_over_open_multipart_uploads`**
- A 5 MiB part plus a tail are copied to the new set. The upload completes on the new set alone and the bytes are
  exact.
- Reverting to the retired indexer alone is Waiting. This is the assertion that shows the seal is necessary.

**Replica: `an_interrupted_commit_is_finished_before_anything_is_served`**
- Admits hang after the seal, giving Pending: not ready, writes refused.
- After a restart it is still Pending. Maintenance finishes the change, then data is served from the new set.

**Replica: `membership_states_follow_the_records`:** a pure state-machine table covering every state, both refusal
cases, and the source and seal sets.

## 5. Results (exact)

All runs are native, with a single build job, one test thread, `MemoryMax=1024M` and `MemorySwapMax=0`. MemAvailable
was at least 16 GiB + 1024 + 256 MiB at every start.

| Run | MemAvailable at start | Result | Peak (cgroup `memory.peak`, includes page cache) |
| --- | --- | --- | --- |
| Full suite, `cargo test` (compile inside the scope) | 18,252 MiB | **47 passed, 0 failed**, 30.8 s | 1,073,741,824 (cap reached, no failure; page cache plus rustc) |
| Same test binary alone | 18,870 MiB | **47 passed, 0 failed**, 32.7 s | 974,508,032. `memory.events`: `max 0`, `oom 0`, `oom_kill 0` |
| Earlier full run, before the admission-locking refinement | 17,953 MiB | 47 passed | 1,030,565,888 |
| `cargo check --target wasm32-wasip2` (production target, no artifacts) | 17,604 MiB | clean, no warnings | 418–548 MB |

- **Logs:** `work/storage-membership-full.log` and `work/storage-membership-full-binonly.log`.
- **Baseline:** the 36 baseline tests all still pass; the remaining 11 are new.
- **Cleanup:** `target/mock-sectors/` is empty afterwards.
- **No release WASM was built.** That waits for all storage fixes to be integrated.

## 6. Mutation probes (isolated scratch copy, never the shared source)

- **Copy:** `work/storage-membership-mutants/sia-s3`, with its own target dir. The baseline build took 6 m 43 s under
  the 1 GiB cap.
- **Restore:** after each mutant the scratch file was restored, and `cmp` against the real tree was identical.
- **Log:** `work/storage-membership-mutants.log`.

| Mutant | Killed by |
| --- | --- |
| M1: legacy readiness by N-W+1 count (the old rule) | 5 tests, including both reproductions and the without-records migration |
| M1b: stable readiness by loaded members instead of admitted ones | interrupted-commit test, state-machine test |
| M2: no seals | 4 tests. With the record-count assertion relaxed (scratch only), the retiring test still fails at the revert assertion: `left: (Stable, true, 1)`. Without seals the retired indexer would serve its stale view alone. |
| M3: no multipart part backfill | the multipart reproduction, the retiring test |
| M4: non-voters count toward W | the without-records migration (writes would succeed while not ready), the interrupted-commit test |

## 7. Guarantees and what is not covered

The model is unchanged: fail-stop, durable acknowledgements, one writer.

**Guaranteed**
- An acknowledged write, delete or part from before a membership change survives it.
- A replica that is empty or not fully backfilled never counts toward readiness or toward W.
- The old set's rules apply until the commit, and the old set never acts after it.
- Stable-membership availability is unchanged: N=3, W=2 serves and writes with one indexer down.

**Costs**
- **Migrations have reduced availability.**
  - From one recorded indexer: that indexer must be up.
  - From a deployment without records: every configured indexer must be up.
  - A commit needs every new member reachable.
- **Removal limits.** A change needs N-W+1 loadable admitted members of the old set and W(old) of them configured to
  take a seal. So remove at most W-1 at once, or list the departing replicas as `retiring`.

**Not covered (documented)**
- **Losing more than N-W members of a set for good.** No change can then be committed from that set; with N=2, W=1
  that is one member. There is deliberately no loss-accepting override; it would be a separate, explicit tool.
- **Dropping every holder of the data from the config.** Nothing is left that knows the data existed.
- **An indexer URL change** counts as a membership change.
- **`sia-s3 import`** writes into one replica only, as before (pre-existing).
- **Indexer rollback or state loss beyond N-W, and Byzantine indexers.**
- **Final-review B2, B3 and B4** are not fixed here.
  - **B2 (unread manifests):** admission and commit already require complete indexes, but `ready()` still does not.
    Admitted voters with unread manifests count, as they did before.
  - **B3 and B4:** untouched. Records carry no write versions.
  - Overlapping interfaces for the B2–B4 worker are listed at the end of `work/storage-membership-interface.txt`.

**Real-network costs (unvalidated)**
- One small upload per record: one per member per change, plus one per old member sealed.
- Record bodies upload outside the write lock. Under the lock there are only metadata pins, which run concurrently
  with the metadata deadline.

## 8. Remaining gates

1. Coordinator review of this diff (uncommitted), and integration with the B2, B3 and B4 work. All of them touch
   `replica.rs`.
2. A real-indexd validation of record pins and the migration timings: activation step 4 in `REPLICATION.md`.
3. A release WASM build from a committed, clean checkout after integration.
