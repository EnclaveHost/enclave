# indexd writer fencing + commit-ordered sequence: implementation result (worker 6b7af721)

**Status: FINAL (2026-10-20 00:3x local; interop extended 02:3x).** Implementation, the full test suite, mutants, the Go end-to-end run and
the real SDK+Go interop gate are all complete. Every outcome below comes from a run that actually happened, with its
log named.

- Scope: everything lives in `work/storage-real-indexd`. No shared source, SDK candidate or main tree was edited; the
  SDK was only snapshotted read-only. No production, keys, SSH, GUI/Wine or commits.
- The main architecture is NOT activated.
- None of this is proof of real Sia retention or funding. Hosts are RHP4 fixtures on loopback, the chain is a
  fixture, and the 768 MiB bounded runs are not production timing.
- Exact hashes for everything named here: `work/storage-real-indexd/FENCE-INVENTORY.sha256`.

## 1. What was built

`work/storage-real-indexd/indexd-fence` is indexd v0.6.0 (ddaf24b) plus an additive patch.

- Patch: `work/storage-real-indexd/indexd-fence.patch`, sha256 `3353bbf722f485801725ce618d7c7c96d11609f096e696c10869a45fe4cfc29c`,
  3705 lines.
- Contract: `work/indexd-fencing-implementation-interface.txt` (sections 1–7 plus REVISIONS R1–R7). Where they
  differ, the revisions win.

**Wire protocol (frozen)**

- **Token:** 32 bytes = gen u64 BE || counter u64 BE || iid 16 bytes.
  - Ordered bytewise.
  - The top bits of gen and counter must be clear.
  - Text form: exactly 64 lowercase hex characters.
- **Credential:** `sf` = token || receipt, as 96 lowercase hex characters.
  - Exactly one occurrence in the query; anything else (duplicate, wrong length, uppercase) → 400.
  - The receipt is 16 bytes from crypto/rand, issued at every install and never returned again.
  - GET /fence shows only its SHA-256 (`receiptSha256`).
- **`POST /fence {"fence"}`:**
  - Strictly greater than the installed token, or nothing installed → 200 `{"fence","receipt","seq"}`.
  - Equal or lower → 409 `{"fence": installed}`. An equal raise is never re-issued a receipt.
  - The first install numbers every existing event (backfill: published events in publish order, then unpublished
    ones by key), including tombstones and blocked objects, and enables the sequence.
- **Fenced mutations (all nine):**
  - POST /objects, DELETE /objects/:key;
  - POST /slabs, DELETE /slabs/:id, POST /slabs/prune (every batch transaction);
  - POST /sharing, DELETE /sharing/:key, POST /sharing/:key/objects, DELETE /sharing/:key/objects/:key.

  Rules:
  - No fence and no sf → 0.6.0 behaviour.
  - Anything other than the exact (token, receipt) → 409 `{"fence": installed|null}`, with no effect.
- **Sequence:** while it is enabled, each event a mutation writes gets `seq = ++accounts.event_seq` in the same
  transaction, under the account row lock. Seqs are therefore in commit order, and a rollback consumes none.
- **`GET /seq/objects?after&limit` (limit 1..1000):**
  - One REPEATABLE READ, READ ONLY snapshot.
  - Returns `{head, events:[{key, seq, deleted, blocked, object?}]}`. Tombstones are included; blocked objects are
    flagged and their metadata withheld.
  - Slab repair and unblock change neither seq nor head.
- **`GET /current/objects`** (the U1 listing, ported):
  - Each page is one snapshot.
  - `&blocked=true` lists blocked keys flagged; the default omits them, exactly as in U1.
- **Signed hash (R5):**
  - With sf, BLAKE2b-256 over the sia Encoder stream: `WriteString("indexd/fence/v3")`, `WriteString(method)`,
    `WriteString(host)`, `WriteString(path)`, `WriteUint64(sv)`, `Write(cred48)`, `WriteBytes(body)`.
  - Without sf, byte-identical to 0.6.0.
- **Not fenced** (operator or background authority): the admin API, slab repair, integrity checks, pruning, funding
  and registration.
- **Relay:** none assumed. The API is per replica and per account.

**Migration (additive):** the new columns are below. The last migration function equals the init.sql tail
(`TestMigrationConsistency` passes).

- `accounts`: `fence` BYTEA(32) NULL, `fence_receipt` BYTEA(16) NULL, `event_seq` BIGINT, `seq_enabled` BOOL,
  `fence_pending` BOOL.
- Constraints: CHECK that `fence` and `fence_receipt` are NULL together, and CHECK that `seq_enabled` needs a fence.
- `object_events.seq` BIGINT NULL, with a unique index on (account_id, seq).
- Hash of that SQL: `627aa30a…d095`.

## 2. Specification gaps resolved (each published; each has an adversarial test, and a mutant where one applies)

| # | Gap in W2 / the SDK v3 draft | Resolution | Evidence |
|---|---|---|---|
| A2 | POST /slabs/prune is multi-transaction | Every batch re-locks and re-checks | TestFencePruneBatchesRaise (451→251 pins at the raise, then frozen); M4 killed |
| A3/R6 | An unfenced pin racing the first raise escapes the backfill. The first fix (FOR UPDATE everywhere) **deadlocked stock TestListObjectsLatePinCommit** and changed 0.6.0 concurrency | Unfenced accounts lock FOR KEY SHARE (concurrent with each other; the raise waits for them); fenced accounts lock FOR UPDATE; a raise that commits mid-lock restarts the mutation (40001) | Stock late-pin test passes; TestFenceRaiseWaitsForInflightUnfenced{Pin,Delete} (deterministic); M3 and M13 killed |
| R7 | New KEY SHARE lockers bypass a waiting FOR UPDATE, so unfenced writers **starved the raise for about 19 s** | The raise first commits `fence_pending`; later mutations then queue behind it | TestFenceConcurrentBackfill: raise takes 4–51 ms under 4 writers (asserted < 2 s) |
| A4/R3 | Blocked objects are silently omitted, so a key looks absent and its unblock resurrects it | Flagged without metadata (`/seq`, `/current&blocked=true`) | TestFenceBlockedUnblockRepair; M6 and M12 killed |
| A6 | A seq could be assigned twice | Unique (account_id, seq); a delete without an event row is an error | TestFenceRollbackNoGaps |
| R1 | Idempotent equal raise: two same-ballot processes both get a working credential | Receipt + equal raise refused. The user's "idempotent equal retry" is deliberately NOT implemented; a lost answer is recovered with counter+1 | TestFenceEqualRaiseClone, TestFenceLostRaiseResponse, E2E S6, SDK two_starters; M1 and M2 killed |
| R2 | httprouter panics on `/objects/seq` next to `/objects/:key` | Route is `/seq/objects` | TestFenceAPIRouteConflict |
| **R5** | The SDK v3 raw hash (`… body || "indexd/fence/v2" || cred`) is not injective. Its "harmless" premise (fences are never removed) is **false**: a restore from a pre-raise backup, or admin delete + PruneAccounts (hard delete) + re-registration, leaves the account with no fence | Only the injective `indexd/fence/v3` stream is accepted, with no compatibility fallback | TestFenceHashV2ReplayAfterFenceLoss against the real HTTP server: in both cases the v2-signed replay **deleted a later writer's object**, and the v3 replay got 401. TestFenceHashVector matches vectors computed independently in Python. M10 and M11 killed. The SDK adopted R5 (00:15) |

## 3. Test outcomes (all run on the FINAL source, PostgreSQL 18.6 fixture, one 768 MiB job at a time, no OOM)

- **Fence store tests, 18/18 PASS.**
  - Logs: `logs/fence-test5.log` (16 tests + migration + stock late-pin), `fence-test7.log` (the 2 in-flight tests),
    and the full persist run below.
  - Coverage:
    - raise rules and bounds;
    - equal-raise clone;
    - all 9 mutations × {absent, stale, higher, wrong receipt, zero receipt}, with no effect when refused;
    - sf on an unfenced account → `{fence:null}`;
    - account isolation;
    - legacy unfenced behaviour;
    - backfill (published/unpublished ordering, tombstone, blocked);
    - block, unblock and slab repair (the stock feed unpublishes; seq and head are unchanged);
    - rollback leaves no gaps (failed pin, absent delete, blocked pin consume no seq);
    - listing bounds;
    - concurrent raise vs pins and deletes (5 rounds: every acknowledged mutation has seq ≤ the raise head, and
      every later one is refused);
    - concurrent backfill;
    - commit order under 6 writers, with a live reader asserting that a seq ≤ a seen head never appears later;
    - paged snapshot plus replay equals the objects table;
    - prune batches vs raise;
    - mixed concurrency (2 accounts sharing a slab, plus repair, block and prune-deleted): about 5.5k–37k
      operations with no error surfacing;
    - lost raise response;
    - in-flight unfenced pin and delete vs the first raise.
- **Fence API tests, 9/9 PASS** (`logs/fence-apitest9.log`; also inside `fence-app-full1.log`). These run over real
  HTTP with a real store:
  - raise and state JSON;
  - every route refused with 409 JSON;
  - canonical sf (duplicate, uppercase, token-only, empty, non-hex, top bits → 400);
  - signature tampering (sf swapped, added, stripped, other route, body, expired → 401);
  - R5 replay after fence loss;
  - seq and current listings: paging, bounds, CBOR, the blocked flag, and a default wire format identical to U1;
  - route conflict;
  - legacy client;
  - hash vectors.
- **Full stock indexd suite on indexd-fence** (`taskset -c 0-3` bounds pgx pools to the fixture's 30 connections):
  - Every package passes:
    - accounts, alerts, api, api/admin, client/v2, contracts (38), geoip, hosts, prometheus, keys
      (`fence-suite-rest2.log`, `fence-contracts1.log`);
    - pins, sharing, slabs, subscriber, testutils (`fence-suite-rest3.log`);
    - persist/postgres: **187 tests + 15 subtests, 0 fail** (`fence-persist-full2.log`).
  - **api/app: 31 PASS, 1 FAIL `TestAppConnect`.** It fails **identically on the stock baseline**
    (`indexd-stock-t`, `logs/stock-appconnect1.log`): `LastUsed` is the same instant, but compared with DeepEqual
    across MST and UTC. This is an environment/timezone baseline failure, not caused by the patch.
  - Historical: `fence-fullsuite1.log`. Its "too many clients" failures came from pgx pools sized at NumCPU=32
    against max_connections 30. The run was killed with a previous session and is superseded.
- **Mutants: 13/13 KILLED** (`logs/fence-mutants.py`, `mutants/results*.txt`, `logs/mut-*.log`).
  - M1 token-only check; M2 equal raise accepted; M3 fenced lock not exclusive; M4 prune batches unchecked; M5 delete
    without seq; M6 blocked metadata returned; M7 hash ignores credential; M8 duplicate sf accepted; M9 backfill
    skipped; M10 body not length-bound; M11 raw v2 hash; M12 current listing hides blocked; M13 unfenced mutations
    unlocked.
  - M13 initially survived. Its race is masked for pins, which take KEY SHARE through FK checks. The deterministic
    in-flight **delete** test now kills it ("the raise completed while an unfenced delete was in flight").
- **`go vet ./...` clean; gofmt clean** (`fence-vet3.log`, `fence-vet4.log`).

## 4. End-to-end (real indexd-fence processes, real RHP4 hosts)

**Go driver `harness/cmd/fencee2e`** (`bin/fencee2e` `2aa53100…`; run `runs/fe2`, `logs/fencee2e-run2.log`):
**48/48 checks PASS**, exit 0, peak 306 MB. The setup is 4 indexers on durable databases, 14 hosts and one app key
shared by writer processes A–E, as in a real deployment.

- **S0:** stock objects; the first raise backfills them (head 1); the stock writer is refused afterwards.
- **S1 delayed old writer:** A's DELETE was held 9 s at every replica by the proxy. B raised in that window, so the
  late delivery got 409 naming B. A's next pin was refused.
- **S2 fresh contender:** B's boot listing (paged in 3s) equals A's acknowledged state on every replica, including
  the tombstone.
- **S3 cold recovery:** C raised (head 7). All replicas list the exact acknowledged state (B's overwrite, B's
  delete, A's delete) and agree. 12/12 sectors read back from the hosts byte-exact.
- **S4 outage:**
  - With r2 down, D got a quorum of 2. The stale C got 0 acknowledgements (409, 409, down).
  - r2 restarted on its durable database still holding C's fence (seq 7).
  - C's write was accepted there: **1 ack < W=2, never acknowledged**. This is the documented per-replica limit.
  - D's raise on r2 showed the stray event at head 8; D repaired and mirrored, and C was then refused everywhere.
- **S5 membership:** new replica r3.
  - sf before any install → `{fence:null}`.
  - D installed (head 0) and mirrored; r3's live set equals r0's.
  - A, B and C (with credentials from r0) and a stock client were all refused.
- **S6 same-ballot race:** each replica issued exactly one receipt (1+2), at most one process reached a quorum, and
  writes followed the receipts.
- Superseded: `runs/fe1` (25 failures from a driver bug that built objects before the slab upload; fixed).

**SDK+Go interop gate (required): PASSED** on the SDK worker's own R5 source (`work/storage-fencing-implementation`,
published `R5-source.sha256` at 00:15:00).

- Setup:
  - Snapshot `sdk-snapshot-r5`: all 24 published hashes verified, digest `151decdc…`.
  - Built unedited into `bin/sdk-r5-driver` `f8b8342f…`.
  - Run against frozen indexd-fence through the **unchanged U1 harness source** (`main.go` `2b975623…`), built with
    `go.fence.mod` into `bin/harness-fence` `46d17706…`, using `run-fence-interop.sh`.
- Native SDK vector test `fencing_wire_vectors_match_indexd_fence_r5`: **ok** (Rust equals Go).
- Real driver cases, all PASS within 768 MiB:
  - `real_fence_endpoint_semantics_exact_receipt_and_refusals`: raise and state with receiptSha256, equal and lower
    refused, unfenced and wrong-receipt refused, exact credential accepted, superseded credential refused, conflict
    recorded.
  - `real_fence_listing_after_install_sees_an_unpublished_acknowledged_pin`: publication stalled 60 s; the next
    writer's listing still sees the acknowledged pin.
  - `real_fence_delayed_old_writer_pins_are_refused_after_a_new_install`: 3 replicas; A's held pins were delivered
    21 s late, got 409 naming B's fence, and B's DELETE held (harness GOMEMLIMIT 160 MiB, peak 745 MB).
  - `real_fence_two_starters_same_counter_one_writer`: safety holds. **Observation for the SDK:** in this run
    *neither* starter ended fresh (`fresh=[false,false]`, the counter re-raised to 2). That is a liveness concern
    under that race, not a safety failure.
- Runs `runs/ifx4`, `ifx5`, `ifx6`; databases dropped, sector files removed.
- Historical, preserved as NOT protocol proof:
  - `ifx2`: the v2-hash SDK snapshot `d62b0ae1` (`sdk-snapshot`). raise, state and refusals interoperate; fenced
    mutations get **401**, exactly as R5 requires.
  - `ifx1`: the same snapshot, memcg OOM at 768 MiB with harness GOMEMLIMIT 256 MiB (driver anon-rss 405 MB).
  - `ifx3`: the same snapshot plus my own R5 patch (`sdk-snapshot/R5-hash.patch`), an experiment.

**Additional interop (02:3x, shared `claude-test-queue.py`, 768 MiB cap) — legacy and unfenced compatibility:**

- The SDK's 7 real U1 cases (`real_indexd::`), run with the same R5 driver in unfenced `u1` mode against
  indexd-fence: **7/7 PASS** (run `runs/ifx7`; memory-guard peakTreeRss 589 MiB; minimum host available 18,321 MiB).
- They cover:
  - acknowledged writes surviving a writer and an indexer restart;
  - listing right after an acknowledged pin;
  - an indexer outage and a restart without it;
  - migration from 1 indexer to 3;
  - late pins inside and outside the signature window;
  - the metadata limit;
  - bootstrap after an acknowledged but unpublished pin.
- All 4 `real_fence_` cases together in ONE queued allocation: **4/4 PASS** (`runs/ifx8`, peakTreeRss 569 MiB).
  `two_starters` again ended `fresh=[false,false]`, now 2 of 2 runs. That is reproducible: safety holds, but neither
  same-counter starter ends up serving. An SDK liveness item.
- Residual for the SDK: it never requests `/current/objects?blocked=true` (R3). An admin-blocked key is therefore
  still silently absent from its boot listing. Recommendation: opt in and fail closed.

## 4b. Review against the 2026-10-20 clarification (platform administration is preserved)

- `api/admin` is byte-identical to stock ddaf24b.
- The admin store paths take no fence lock and need no credential. That covers block/unblock, account
  delete/update, PruneAccounts, quotas, connect keys, host bans and contract or slab maintenance.
- Admin moderation applies to fenced accounts exactly as in 0.6.0:
  - a fenced writer cannot override a block (a pin of a blocked key → ErrObjectBlocked, consuming no seq);
  - blocked objects are flagged and their metadata withheld in both listings;
  - the operator can delete, prune and re-register accounts. R5 exists precisely so that this admin path cannot be
    abused to turn captured fenced requests into accepted unfenced ones.
- The fence is per-account writer exclusion among the account owner's own processes. It is not an authority above
  Enclave administration, and it gives no moderation bypass.
- No contract, chain, binding or ownership change. The token's `gen` is opaque to indexd: no Ledger17 or other
  contract dependency is introduced on this side.

## 5. Exact hashes (full list: `work/storage-real-indexd/FENCE-INVENTORY.sha256`)

- **Source** (changed vs ddaf24b):

  | File | sha256 prefix |
  |---|---|
  | accounts/fence.go | 4e3060ed |
  | api/app/app.go | 818d2414 |
  | api/app/auth.go | 9d5e9d36 |
  | api/app/client.go | ecbde2d0 |
  | api/app/fence.go | 4bc0144e |
  | persist/postgres/fence.go | bd00bd88 |
  | persist/postgres/current.go | 37d8e8d6 |
  | persist/postgres/objects.go | 5a5d0354 |
  | persist/postgres/sectors.go | 9840e45b |
  | persist/postgres/sharing.go | c6ecf1e7 |
  | persist/postgres/slabs.go | 95051adf |
  | persist/postgres/init.sql | ad7e4463 |
  | persist/postgres/migrations.go | eba472fe |
  | sharing/manager.go | 1e441fb2 |
  | slabs/manager.go | 2a0bfb81 |
  | slabs/objects.go | 6d88ffff |
  | slabs/seq.go | 793f8d2a |
  | slabs/slabs.go | 12bf4050 |

- **Test-only:** fence_test.go (persist `afe41e1b`, api `bb4d41a8`), export_test.go, store_test.go and testutils/db.go
  (the POSTGRES_PORT and DB-prefix test patch), migrations_test.go.
- **Binaries:**

  | Binary | sha256 prefix |
  |---|---|
  | fencee2e | 2aa53100 |
  | harness-fence | 46d17706 |
  | sdk-r5-driver | f8b8342f |
  | sdk-snapshot-driver (v2, historical) | bfe9be62 |
  | sdk-snapshot-r5-driver (experiment) | c69ddbe1 |

- **U1 negative control, unchanged and matching the U1 report:**
  - bin/harness `a69daf18…`, bin/harness-u1 `d2bed640…`, bin/sias3-real-driver `1a10c22b…`;
  - indexd-u1.patch `4bc1e0a8…`;
  - harness main.go `2b975623…` (mtime 21:59, before this task).

## 6. Limitations and remaining items

1. **Per-replica fencing only.** A replica that missed a raise (outage) accepts the stale writer until the next
   raise reaches it (E2E S4). Safety relies on the SDK's quorum, W=2 of 3, raised on W before serving, and on
   reconciling stray events seen at raise.
2. **Liveness:**
   - On a fenced account, a mutation blocked on a slab lock held by another account head-of-line-blocks that
     account's other mutations, because they are serialized by design.
   - Two same-counter starters can both lose (SDK observation above).
3. **Fence loss is an operator event.** After an admin restore, or a delete+prune+re-register, the account is
   unfenced again; R5 only ensures old signatures cannot be converted into unfenced requests.
   - Within an sv window, a captured *fenced* request is still replayable as a fenced request on the same replica
     while the same (token, receipt) is installed. That is the same as 0.6.0 replay semantics.
4. **No tombstone pruning in v0.6.0.** A future indexd that prunes `object_events` tombstones would need a low
   watermark on `/seq/objects`.
5. **`TestAppConnect`** fails on stock in this environment (timezone). Not addressed: it is outside scope.
6. **Resources.** Everything ran under the coordinator-approved 768 MiB cap, starting at ≥ 17,920 MiB available,
   with the 16 GiB floor kept.
   - The 3-replica SDK driver needed the harness's GOMEMLIMIT at 160 MiB to fit (peak 745 MB). At 256 MiB it was
     OOM-killed (`ifx1`; driver anon-rss 405 MB).
   - The Rust snapshot builds reached the cap with reclaim (`memory.events max` > 0, `oom_kill 0`).
7. **Cleanup done.**
   - All `sias3_real_*` databases dropped (count 0).
   - Host sector directories removed (sizes in `runs/*/resources.txt`).
   - Snapshot build caches (about 1.9 GB each) deleted.
   - Mutant tree removed.
   - No background jobs, watchers or scopes of mine are left running.
   - The fixture password appears in no log (checked by comparison only). The pgx username was redacted from my fence
     logs. Signed queries are redacted in E2E and interop evidence.
