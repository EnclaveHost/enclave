# sia-s3 replication: final activation review (read-only, 2026-10-20)

**Scope**
- **Repository:** `work/enclave-apps-sia-recovery/sia-s3`, at **`54818ba`** with a clean tree. It was reviewed against
  base `446ac5f`.
- **Line numbers** below are from `54818ba`.
- **Read in full:** `REPLICATION.md`, `src/replica.rs` (non-test, and the test list), `src/store.rs`, the `src/main.rs`
  boot path, `src/config.rs`, the `src/s3.rs` diff, the relevant parts of `src/recovery.rs`, and the vendored SDK's
  metadata sealing, request signing and mock gating.

**Not done**
- No edits, build, test run, fuzzing, mutation, production access, SSH, chain access, Wine or UI.
- No reproduction was needed. Each finding below is shown from the code path.
- Worker `6b7af721` owns reproduction and the fix for membership and migration (B1). Nothing here marks it resolved.

**Not a certification.** Local mock tests (36/36) do not establish decentralization or real-indexd behaviour.

## Verdict

**Not ready for a clean release.** There are four blockers, listed by severity. B1 is the coordinator's membership
concern, and it is confirmed.

| # | Class | Blocker |
| --- | --- | --- |
| B1 | **Proven bug (logic), membership** | Replicas that are empty or not yet backfilled count toward the boot quorum. Adding replicas, or removing one, breaks quorum intersection with past writes. |
| B2 | **Proven bug (logic), load path** | A replica whose manifest bodies could not be read loads anyway, without those keys. It counts toward the boot quorum, and its maintenance can delete data those manifests reference. |
| B3 | **Proven race (logic)** | `reconcile()` swaps in a fresh index while compaction (or `upload_part`) is still pinning and deleting on the old store. The fresh index then points at deleted objects, and nothing marks it dirty. Single-indexer deployments are affected too. |
| B4 | **Conditional gap (undocumented assumption)** | "Late writes from a stopped writer cannot resurrect deletes" holds only if the new writer's wall clock is ahead of the old writer's. Clock skew at writer failover breaks it. |

## B1. Membership: empty or lagging replicas satisfy the boot quorum

### Evidence

- **`replica.rs:308-322`.** `read_quorum() = n - write_quorum + 1`, and `ready()` is
  `loaded().len() >= read_quorum()`. Any loaded replica counts, whether or not it holds the history.
- **`main.rs:114-121`.** `boot` starts one `load_replica` task per replica (`main.rs:86-112`) and serves as soon as
  `ready()` holds. An empty indexer lists nothing and loads in seconds. The established replica lists every object and
  downloads manifest and ledger bodies (`store.rs:582-650`), so it loads last.
- **`REPLICATION.md:163-164`** (add a replica: "keep N - W + 1 reachable for the next restart, and restart. Repair
  backfills it") and **`REPLICATION.md:167`** (remove an indexer: "Remove it and restart"). Neither requires the replicas
  holding past writes to be in the boot set.
- **`replica.rs:755`.** A DELETE of a key absent from the merged view returns `Ok(())` (204) and records nothing.
- **Tests: none cover membership change.**
  - `cluster()` attaches every replica.
  - `writes_continue_through_an_indexer_outage_and_repair_backfills` (`replica.rs:1443`) is N=2, W=1, where
    `read_quorum = 2`.
  - No test covers single to multi migration, boot with only new replicas, boot during backfill, or removal.

### The mechanism

Quorum intersection holds only for writes that were acknowledged by W replicas **of the current membership**. Data
written under the old configuration does not meet that:

- written under N=1, W=1, it exists on the old replica only;
- written under N=3, W=2, a write acknowledged on {A, C} exists on two replicas, one of which may later be removed.

### Concrete failures (deterministic from the code)

**1. Adding two empty replicas to an existing single indexer (N=3, W=2, `read_quorum = 2`).**

- At the first restart, B and C (empty) load before the primary, so `ready()` is true with **zero** of the existing data.
- If the primary is unavailable, that state lasts indefinitely. If it is merely slower (the normal case), the state lasts
  until the primary attaches.
- During that window:
  - GET and HEAD answer 404, and LIST is empty;
  - `PUT If-None-Match: *` overwrites existing keys (`cond_ok`, `replica.rs:271-279`);
  - **DELETE of an existing key answers 204 and records nothing** (`replica.rs:755`), so the key **reappears** when the
    primary attaches. That is an acknowledged delete lost.
  - New writes are safe: their versions are newer than everything.

**2. A restart during backfill** (repair moves at most `repairMaxBytesPerPass`, 1 GiB, every 300 s; about 5 passes for
today's ~4.7 GB, plus one object per key) **with the primary unavailable.** This is the same as case 1, for every key not
yet copied.

**3. Removing a replica.**

- With N=3, W=2, a write acknowledged on {A, C} has two copies. After C is removed (N=2), the default W is a majority, 2,
  so `read_quorum = 1`.
- A boot from B alone is ready and misses that write (and any delete recorded only on A and C).
- The documented "Remove it and restart" does this whenever repair has not first verified that every remaining replica
  is complete.

### Minimal fix (for the assigned worker)

- **Readiness only from replicas that hold the history.**
  - Mark a replica `joining` until maintenance has verified that it holds every key version and every floor of a view
    that itself came from a proper boot quorum.
  - Mark it with a durable marker on that replica (for example a small object recording the membership hash and
    "complete"), or as an explicit config flag (`"joining": true`) that the operator clears only after `/healthz` shows
    `behind = 0` and equal floor counts.
  - `ready()` counts only non-joining replicas, and requires
    `established_loaded >= established_n - w + 1`.
  - When N grows from 1, that means the old primary must be loaded.
- **DELETE of a key absent from the view** while any configured replica is not loaded, or is dirty: record a floor at
  `tick()` on a write quorum, instead of `return Ok(())` at `replica.rs:755`.
- **Removal procedure:** run repair to completion, check every remaining replica (`behind = 0`, floors equal), and only
  then remove. Alternatively, choose W' so that N' - W' + 1 covers the replicas that held each past write.
- **Tests:**
  - single to N3W2 with the primary's listing delayed: not ready until the primary attaches;
  - the primary offline: never ready with only the empty replicas;
  - DELETE of an existing key during a partial load is recorded and survives the primary's attach;
  - removal before backfill is refused or not ready, and after verified backfill it works;
  - `If-None-Match` during a partial load does not overwrite.

## B2. Unreadable manifest bodies: the replica loads without those keys

### Evidence

- **`store.rs:468`.** A manifest object whose body was not read goes to `idx.unresolved`, and its key is absent from
  `idx.keys`.
- **`store.rs:639`.** A manifest download error is only logged.
- **`store.rs:644-647`.** Only **unread ledgers** stop the load. Unresolved manifests do not, so `fetch_index` returns
  `Ok`, and `load_replica` attaches the replica and counts it toward `ready()`.

### Why it matters

Manifest bodies are downloaded from Sia **hosts**, so a read failure is not an indexer fault. The fail-stop indexer model
does not cover it. It happens with host churn, slow hosts, or slabs the indexer failed to repair.

### Consequences

- **Acknowledged writes can disappear at a cold restart with one indexer unavailable.**
  - Example: N=3, W=2; version v2 of K (a manifest: long key, multipart over 1 KiB, or a copy onto a crowded object) is
    acknowledged on A and B.
  - B is down and the boot set is {A, C}. A cannot read v2's manifest body.
  - The view then serves C's or A's older v1 (stale bytes for an acknowledged overwrite), or 404.
- **Data deletion from an incomplete index.**
  - `drop_parts` (`store.rs:803-821`, used by `detach`, `tombstone` and `purge_dead`) keeps an object only when
    `referenced_elsewhere` finds a key in `idx.keys` using it.
  - `compact()` (`store.rs:1295-1379`) skips only objects that `is_part()` (`store.rs:562`) finds in `idx.keys`.
  - A CopyObject destination stored as a manifest over the source's data objects is invisible while unresolved. So
    overwriting or deleting the source, or compacting it, deletes or moves the destination's data, and its manifest is
    left pointing at nothing.
  - Only `sweep()` checks `unresolved` (`store.rs:1381-1383`).
- **Inconsistency:** `recovery export` already refuses an index with unresolved manifests (`recovery.rs:195`), but
  serving and maintenance proceed.

### Minimal fix

At `store.rs:644`, treat `!idx.unresolved.is_empty()` like unread ledgers: return `Err` (the replica stays unloaded and
retries, and `reconcile` keeps the old index). That trades availability for safety, as ledgers already do.

A finer alternative: keep the replica loaded but out of `ready()`, and block `compact`, `purge_dead` and `drop_parts` on
it until its manifests resolve.

**Test:** clear a manifest object's sectors (the mock's `clear_sectors`), then restart with one of the other replicas
offline. Assert the replica is not ready, no stale version is served, and the copy destination's data survives a source
overwrite.

## B3. `reconcile()` races compaction and part uploads

### Evidence (`replica.rs:402-430`)

1. `before = old.changes.get()`, then a full re-listing.
2. `self.write.lock()`.
3. Check `old.changes.get() != before` (line 408).
4. **Then `await old.idx.lock()`** (line 416), to copy open uploads.
5. Swap (line 425).

### The race

- `compact()` (`store.rs:1337` onward) runs from the boot loop **without** the cluster write lock. It holds `old.idx`
  while it pins repacked objects and **deletes** the originals.
- If `reconcile` passes the check while compaction holds `old.idx`, it waits at step 4 while compaction mutates the
  indexer, and then swaps in an index listed **before** those changes.
- A compaction (or `upload_part`, `abort_upload` or `sweep`) still holding the old `Rc<Store>` can also run its pins and
  deletes **after** the swap.
- `remote()` (`store.rs:719`) does not know the store was replaced. The calls succeed, so nothing marks the fresh store
  dirty and no re-read happens.

### Impact

- The fresh index points compacted keys at deleted objects, so reads of those keys fail on that replica until the next
  restart or dirty event.
- **This applies to N=1, which is today's single-indexer production configuration.** There, `repair_loop` reconciles any
  replica made dirty by a metadata timeout, compaction runs every 30 minutes with long uploads, and the affected keys
  become unreadable.
- A part uploaded in the window is missing from the fresh index, so CompleteMultipartUpload answers `InvalidPart`.

### Minimal fix

- Take `old.idx.lock()` **before** re-checking `changes`, hold it through the swap, and set `old.retired = true` under it.
- `Store::remote()` refuses on a retired store (and compaction re-checks after taking the lock), so late calls on the old
  `Rc` do nothing.
- Alternatively, run compaction and `upload_part`'s index update under a per-store guard that `reconcile` also takes.

**Test:** a dirty replica, with a compaction in progress holding the index during reconcile. Assert every key still reads
after the swap.

## B4. Cross-writer clock ordering

### Evidence

- `replica.rs:297`: `clock: Cell::new(0)`.
- `replica.rs:336-340`: `tick() = max(now_ms(), clock + 1)`.
- `rebuild()` raises the clock only to versions **loaded** (`replica.rs:432-460`).
- Floors hide only versions **older** than the floor (`store.rs:497-498`, `replica.rs:458`).
- The claim, in `REPLICATION.md:77-79` and the module header in `replica.rs`: requests left in flight by a stopped writer
  "cannot bring a deleted key back (floors hide them)".

### The failure

1. Writer P1, on host X, stamps PUT K at h=T1, and the request is abandoned.
2. P1 stops. P2 starts on host Y, whose clock is behind X's by more than the failover time.
3. P2 DELETEs K at h=T2 < T1. The floor is T2.
4. P1's PUT lands later, with T1 > T2. **The key is resurrected.**

In the same way, a 503'd PUT from P1 can outrank an acknowledged PUT from P2. This needs no Byzantine behaviour, only
writer failover across hosts, which `REPLICATION.md:141-144` names as an Enclave-level concern.

### Minimal fix

- Start the clock at `now_ms() + margin` (a configurable `clockSkewMarginMs`, defaulting to minutes; versions are only
  compared, so jumping ahead is harmless).
- Document that writer hosts must keep clock skew below the margin.
- A durable alternative: reserve clock ranges on W replicas before using them (a ceiling record that boot reads).

## Lower severity (should fix; not blockers)

**L1. Signed indexer request URLs can reach the unauthenticated status page.**
- Every SDK app request carries its signature in the URL query (`sv`/`sc`/`ss`; `app_client/http.rs:603-660`), valid for
  60 s.
- Transport errors are `Error::Reqwest(reqwest::Error)` (`app_client.rs:57-58`), whose display text includes the request
  URL.
- They pass through `Store::remote` (`store.rs:719-734`) and `Cluster::note` (`replica.rs:331-334`) into
  `replicas[].error`, which `/healthz` and the status page show unauthenticated (`replica_status`,
  `replica.rs:1163-1187`), as is `boot_error` (`main.rs:94-100`).
- Impact: replay of that exact idempotent request within 60 s. The app key's public part (`sc`) is not secret.
- **Fix:** strip the query from error text (reqwest's `without_url()`, or redact anything after `?`) in `remote()` and
  in `note()`.

**L2. The real indexd metadata limit is unverified.**
- `MAX_META = 1024 - 24 - 16` (`store.rs:345`) matches the SDK's sealing exactly: a 24-byte XChaCha nonce plus a 16-byte
  tag (`object_encryption.rs:156-163`).
- But indexd's `MaxMetadataSize` is not in this tree, and the mock indexer does not enforce any limit. The client-side
  `meta_bytes` check is the only enforcement in tests.
- This is activation step 4 in `REPLICATION.md` (architectural or validation work, not a code bug).

**L3. Same-second legacy ties.** Legacy 0.1.x entries with equal `m` and an empty write id tie, and the winner is map
iteration order (`store.rs:476-488`). 0.1.x did the same, so this is not a regression. But a repair copies whichever won,
with the legacy stamp, so replicas can disagree until one is rewritten.

**L4. Late manifest pins and the orphan sweep.** A manifest key's data object is pinned before its manifest. If the
manifest pin is abandoned and lands more than a day later, `sweep` may already have deleted the data object as an orphan
(`store.rs:1386-1393`). Only unacknowledged writes are affected, and reads fail over. Note it as a known edge.

## Verified sound (within the stated fail-stop, durable-acknowledgement, one-writer model)

- **Acknowledgement ordering.**
  - Every `Ok(true)` that counts toward W is returned only after the indexer acknowledged the pin: `commit_put`
    (`store.rs:836-874`), `commit_copy`, `commit_complete`, `tombstone` (`store.rs:950-990`) and `write_ledger`
    (`store.rs:1077-1100`) all update the in-memory index only after the remote call succeeds.
  - DELETE's quorum (`recorded`, `replica.rs:800-811`) therefore counts acknowledged tombstones and floors only.
  - Abandoned metadata calls mark the replica dirty (`replica.rs:376-385`, `store.rs:719-734`).
- **Floors are never dropped.**
  - An unread ledger refuses the load (`store.rs:644-647`).
  - `merge_ledgers` pins the merged ledger before deleting old ones, and deletes only ledgers that existed before
    (`store.rs:1102-1124`).
  - `reclaim_covered` removes tombstones only under a floor on the same replica (`store.rs:1126-1142`).
  - Floors and tombstones hide older versions at load (`store.rs:497-498`), in the view (`replica.rs:458`), and on
    commit (`superseded`, `store.rs:576-580`).
- **Repair does not restore stale bytes.**
  - It copies only the view's current newest version, re-checks under the write lock that the key has not changed
    (`replica.rs:1087-1093`), and `commit_put` refuses anything superseded.
  - Copies are checked by size, and by MD5 for single-part ETags (`replica.rs:949-976`).
  - Missed deletes are applied as tombstones.
- **Encryption and sector proofs remain real.**
  - Production uses `sdk.upload`/`download` unchanged.
  - The vendored diff touches only the mocks, which are gated by `cfg(any(test, feature = "mock"))` (`lib.rs:73-74`,
    `rhp4.rs:20-21`).
  - The `mock` feature is enabled only as a dev-dependency (`Cargo.toml:32-33`), and edition 2024 (resolver 3) keeps it
    out of release builds.
- **Existing S3 surface.**
  - Requests are gated on `ready()`.
  - GET, HEAD, ranges, conditional reads, LIST, multipart, CopyObject and conditional PUT keep their semantics over the
    merged view.
  - New mappings: 503 `ServiceUnavailable` on quorum failure, and 400 for `EntityTooLarge`.
  - A conditional PUT is re-checked under the write lock at commit (`replica.rs:683-685`).
- **Single-indexer back-compatibility.**
  - A config without `replicas` becomes one `primary` with W=1 (`config.rs:117-122`).
  - 0.1.x entries order by `m * 1000` (`store.rs:99-101`).
  - Rollback to 0.1.x after v2 objects exist is unsupported (documented).
  - B3 applies to this configuration too.
- **Config.**
  - Seeds are redacted in `Debug` (`config.rs:50-55`).
  - An unset `$NAME` is an error, never a fallback to another key (`config.rs:141-147`).
  - URLs are canonicalized, with credentials, query, fragment and non-http(s) schemes refused.
  - Duplicate URLs and names are refused, `writeQuorum` is 1..N, timeouts have minimums, and there are at most 16
    replicas.
  - Plain http gives a warning.

## Documented fault-model limits (not bugs)

- These are not Byzantine guarantees: a lying majority defeats them.
- One writer, with no fencing in indexd.
- Floors grow forever (about 80 bytes per deleted key).
- Every replica stores its own N copies.
- Indexer operators remain the authority for contracts, renewal, funding, repair and listing. The SDK has no app-held
  contract path.
- Real-network timing and limits are unvalidated.
- Cold recovery works per replica, from that replica's snapshot.

## Migration path for existing data

**Mechanism.** It works only after the primary has attached:

- repair backfills the newest versions, at 1 GiB per pass by default, one object per key on the new replica (shared or
  packed objects are split);
- maintenance copies every floor;
- legacy entries are copied with their legacy stamps.

**Unsafe today.** Per B1, the procedure must keep the old primary in every boot set until each new replica is verified
complete (`behind = 0`, equal floors). Only then can the new replicas count toward the boot quorum. It also needs a
membership-aware `ready()` and tests.
