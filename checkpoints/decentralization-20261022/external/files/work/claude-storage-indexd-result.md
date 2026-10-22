# sia-s3 against a running indexd: harness, U1 reproduction and isolated fix (2026-10-19)

**Owner:** worker 6b7af721.

**Paths:** all under `work/`, resolved from `/home/steven/Documents/Codex/2026-10-18/wo`. The harness lives in
`work/storage-real-indexd/`.

## 1. What was proven, in one table

The final runs used the final binaries (hashes in section 7). Each ran in ONE systemd scope:
- `MemoryMax=1024M`, `MemorySwapMax=0`;
- one build job beforehand, one test thread;
- a 16 GiB host floor watchdog, and a start floor of 18 GiB.

The coordinator's PostgreSQL 18.6 fixture runs separately at `127.0.0.1:55432`, with its own 384 MiB limit.

| Run | indexd | sia-s3 listing | Result | Exit | OOM | Peak RSS harness / driver |
| --- | --- | --- | --- | --- | --- | --- |
| `v060c` | stock v0.6.0 (`work/indexd`, ddaf24b, unmodified) | event feed, **as in the main tree** | **7 passed, 0 failed** | 0 | 0 | 274 MB / 426 MB |
| `u1b` | v0.6.0 + `indexd-u1.patch` (isolated copy) | current listing (**U1 fix**, isolated sia-s3 copy) | **7 passed, 0 failed** | 0 | 0 | 306 MB / 422 MB |

Earlier, identical runs (`v060b`, `u1a`, before the last driver-assertion and redaction edits) also passed 7/7.

**Notes on the numbers**
- **Peak:** the cgroup `memory.peak` reached the cap from page cache (the fixture hosts write 4 GB of sector files per
  run). The reclaim events were `max 661` and `max 0`, and `oom_kill` was 0.
- **Logs:**
  - per run: `logs/real-<run>.log` and `runs/<run>/{driver.log,events.jsonl,harness.log,rss.log,resources.txt}`;
  - binaries: `logs/final-binaries.sha256`;
  - sources: `logs/final-sources.sha256`.

**These are real**
- indexd v0.6.0's application and admin HTTP APIs, with signed-request authentication. The SDK's request signatures
  are verified against the advertised URL.
- indexd's account, contract, host, slab, pin, subscriber and stats managers.
- `persist/postgres` with its migrations, on an actual PostgreSQL server: one database per indexer, kept across
  indexer restarts.
- Hosts running coreutils' real RHP4 server over siamux.
- sia-s3's own Store, Cluster and SDK code, with real encryption, erasure coding and sector proofs.

**These are fixtures (stated in `harness/cmd/harness/main.go`)**
- The chain: a coreutils test network, mined on demand.
- Host contract state (`EphemeralContractor`).
- Host sector storage (`rtu.DiskSectorStore`, files on the work disk).
- indexd's explorer and host online checker (mocks).
- The holding proxy in front of each indexer: it forwards bytes unchanged, or holds a request to deliver it late.

**Fixture tuning, all stated in code**
- Hosts listen on `[::1]` only and announce `[::]:port`. indexd rejects loopback host addresses (`isPrivateIP`), but
  not the unspecified address, which reaches `::1`.
- The harness runs 14 hosts and requires at least 12 contracts, because 3+9 shards need 12.
- Slab health and integrity checks, and repair migrations, are hourly or off. At 500 ms they downloaded 4 MiB
  sectors constantly and OOM-killed a 640 MiB scope (`full1`).
- The harness is pinned to 2 CPUs (`taskset`) so pgx pools stay at 4 connections each. The fixture refused 200 pooled
  connections with "too many clients".

**Not proven by any of this:** live Sia host retention, contract funding and renewal, real-network timing, more than
one machine, or decentralization.

## 2. Scenario results on stock indexd v0.6.0 (the main tree's behaviour)

- **Acknowledged writes survive a writer restart and an indexd restart on its database.** This covered:
  - an inline key, a manifest key (700-character key), a DELETE (tombstone), and a completed 2-part multipart
    (5 MiB + tail);
  - an open upload;
  - the membership record and the version ceiling.

  Evidence: after the restart the state is `(Stable, true, 1)`, `observedCeiling` equals the written ceiling, every
  key reads back exactly, the delete holds, and the open upload completes.
- **One indexer outage** (N=3, W=2):
  - writes and a DELETE succeed with r2 stopped;
  - a cold writer boot with r2 down is `(Stable, true, 2)` with 2 loaded, and the data and the delete hold;
  - r2 is restarted and backfilled; then r0 is stopped, and r1 plus r2 serve everything.
- **Migration from 1 to 3 indexers:** `Migrating` epoch 1 → commit → `Stable` epoch 3 (record-less epoch 2 is
  skipped, per final review F1). With the old indexer stopped, the new members serve the data and the delete.
- **Late pins, measured on real indexd:**
  - a pin held by the proxy and delivered **15 s** late got **204** and was **applied**: listed after a re-read;
  - one delivered **67 s** late got **401** "invalid signature" and was **not applied**.

  So stock indexd bounds how late a client-abandoned request can apply, by the SDK's 60 s `sv` signature. The
  model's "applied arbitrarily late" is conservative.
  - Requests accepted in time but processed slowly server-side are not bounded by this. Production indexd sets 30 s
    HTTP read and write timeouts (`cmd/indexd/run.go:307,348`); the harness's test server does not.
- **Metadata limit (final review L2):**
  - 983 and 984 plaintext bytes were accepted;
  - 985 was rejected with **400** "object metadata size limit (1024) exceeded: got 1025 bytes";
  - 1024 was rejected (1064).

  sia-s3's `MAX_META = 984` equals the real limit (`slabs/objects.go:193`).
- **L1:** a real SDK transport error carries the signed request URL (`sv`, `sc`, `ss`). main's boot path redacts it
  (`store::redact`). The driver's first logs printed them raw: disposable test keys on loopback, already expired.
  Those logs were redacted in place, and the driver now redacts its own output.

## 3. U1: the bootstrap defect, demonstrated on a running indexd

**Source (indexd v0.6.0)**
- Every pin, re-pin and delete sets `object_events.updated_at = NULL` (`persist/postgres/objects.go:354,436`).
- The feed's `(updated_at, object_key) > cursor` drops those rows (`:199-205`).
- A 1 s publisher fills them in (`slabs/manager.go:23`, `objects.go:497-560`), stalling while the database clock is
  behind its last published second.
- The reviewer adds that slab repair (`RecordSlabMigrated`) and unblocking also unpublish objects. That path was not
  exercised live here, because migrations are disabled in the harness.

**Reproduced in run `v060c`, scenario `real_bootstrap_after_an_acknowledged_but_unpublished_pin`**
1. `k = v1` is written and published.
2. Publication is held using indexd's own stall condition (`global_settings.object_events_last_published` set 60 s
   ahead of `NOW()`).
3. A writer PUTs `k = v2`, acknowledged by indexd.
4. The **next writer boots**: `kSeen: null`. The feed listing misses the acknowledged PUT, and v1's removal too.
5. Its **DELETE answers success with `deleteRecorded: false`**.
6. Publication resumes. After a boot, **`k = v2` is back**: an acknowledged DELETE undone.
7. Also: the fix's listing against stock indexd **fails closed** with "the indexer has no consistent object
   listing…".

**Not only under a stall.** In `real_listing_right_after_an_acknowledged_pin` on stock indexd:
- **0 of 5** listings taken 6–21 ms after an acknowledged pin contained the new object;
- **0 of 5** contained the deletion.

So any boot or re-read within about a second of a write is affected, not just one during a publication stall.

## 4. U1 fix (isolated; the main tree is untouched)

### indexd contract (`indexd-u1.patch`, 136 lines, on v0.6.0; copy in `indexd-u1/`, built and vetted offline)

- **Endpoint:** `GET /current/objects?after=<object key>&limit=N`, with signed app auth. It returns `[]ObjectEvent`,
  the feed's shape.
- **Query:** `objects WHERE account_id AND object_key > after AND NOT blocked ORDER BY object_key LIMIT`. Slabs are
  loaded in the same transaction; a row whose slabs vanished mid-read is left out.
- **Guarantee:** consecutive pages return every object whose pin **committed before the first page** and that is not
  deleted before its page is read, exactly once, with metadata as committed when its page is read. Keys are
  immutable, pages cover strictly increasing key ranges, and each statement reads committed data.
- **What it does not depend on:** object-event publication, its 25,000-event batches, `SKIP LOCKED`, the clock stall,
  or repair-driven unpublishing.
- **What it does not claim:**
  - it is not a point-in-time snapshot (pins committed during the listing may or may not appear);
  - it is not fencing;
  - blocked objects are omitted, like the feed. The fencing revision prefers flagging them.

### SDK and sia-s3 (isolated copy `storage-real-indexd/sia-s3`)

- `Sdk::current_objects`.
- `MockNetwork::hold_publication`: the feed omits held pins and deletes; the current listing does not.
- `Opts.listing`: `Current` is the default; `Feed` is kept only to demonstrate the defect.
- `fetch_index`, used at boot and on every re-read, pages the current listing. An indexer without the endpoint fails
  the load: fail closed, with no fallback to the feed.

### Tests

| Test | Result | Log |
| --- | --- | --- |
| native `an_unpublished_pin_is_missed_by_the_feed_and_listed_by_the_current_listing` | passes: Feed undoes the acknowledged DELETE; Current holds | `logs/u1-native-one.log` |
| isolated copy's full native suite | **68 passed, 6 ignored** (the real driver at that time), 0 failed; exit 0, oom 0 | `logs/u1-native-full.log` |
| real, run `u1b` | the same stalled boot sees `v2` (`kSeen: 2`); the DELETE is recorded and holds after publication, and the feed agrees; **5/5** immediate listings include the new object and the deletion (asserted) | `runs/u1b` |

`store.rs` and `replica.rs` are unchanged since the native suite run. Only the ignored driver file changed after it.

**Not done for U1**
- No Go unit test of the patched indexd store against PostgreSQL. indexd's test helper hard-codes port 5432; the
  endpoint was exercised only through the harness.
- Not proposed upstream.
- Not merged into main. Main remains held for the API-contract decision.

## 5. Concurrent writers, fencing, and the pre-B4 cutover

### From indexd's source and the runs

- **No conditional pin.** A pin is an unconditional upsert by object id (`persist/postgres/objects.go:426-427`). Last
  writer wins per object, and indexd cannot fence a second writer.
- **What B4 orders, and what it doesn't.** B4 orders writers one after another. With two live writers, the older one
  keeps acknowledging writes stamped inside its own range, below the newer writer's floors. Those writes can be
  hidden or lost, and conditional PUTs are wrong. One writer at a time remains a hard operational requirement until
  a fence exists.
- **The fencing proposal is not approved** (coordinator, 2026-10-20). The U1 endpoint is independent of it; a fence
  design could reuse it as its listing.

### Safe cutover from a pre-B4 writer, or any planned writer change

The bounds below were measured or read from source here.

1. Stop the old writer and confirm the process has exited. A signal is not enough.
2. Wait at least **60 s**: the SDK's signature validity. The real indexd rejected a request at 67 s.
3. Wait a further **30 s**: production indexd's server timeouts. Add a margin; in total, at least 2 minutes.
   - Check which SDK the old binary used. The 60 s figure is this vendored SDK's; a 0.1.x binary must be checked.
4. **On stock indexd, the feed listing is not complete (U1).** Before starting the new writer, an operator with
   indexd admin access confirms that `GET /stats/objects` reports `unpublishedEvents: 0` (a global count). Also
   check the database clock against the last published second.
   - This barrier covers planned cutovers only. A writer restarting by itself after a crash has no such step, so U1
     remains an activation blocker without the patch.
5. Start the new writer. Its clock floors above every loaded version and ceiling.

### `sia-s3 import` (final review D1)

Import is a second writer, outside B4 and membership. Run it only with every server stopped, then apply the same
publication barrier (step 4) before starting the server. The server must list the imported versions before it
stamps anything.

## 6. Resources and cleanup

- **Every heavy job ran bounded**, through `logs/run-bounded.sh`:
  - one scope, 1024M, no swap, `CARGO_BUILD_JOBS=1`;
  - a 1 s watchdog that stops only its own scope below 16 GiB MemAvailable;
  - `memory.peak` and `memory.events` recorded;
  - no concurrent heavy jobs.

  Each run waited for MemAvailable of at least 18 GiB before starting. Three attempts were refused by that check and
  retried later.
- **Failures on the way, all diagnosed and fixed in the harness:**
  - `full1` and `full2`: the 640 MiB scope was OOM-killed. The first time it was indexd's 500 ms integrity checks;
    the second time the Rust driver reached 404 MB anonymous memory on a 3-replica PUT. Real indexd's minimum
    layout is 3-of-12 (`ValidateECParams`: redundancy at most 4, 99.99 % recovery at p = 0.75), so every replica
    buffers 48 MiB per slab.
  - `smoke1`: too many PostgreSQL clients.
  - `smoke2` and the debug runs: loopback hosts rejected.
  - `v060a`: 11 of 12 contracts.
- **Databases:** every database this worker created (`sias3_real_<run>_r{0,1,2}`) was dropped. `harness -list-own`
  reports **"0 own databases"**. The fixture container is the coordinator's.
- **Sector files:** fixture sector files were deleted after each run (about 4 GB per run, sizes in
  `runs/<run>/resources.txt`), and the stale ones from failed runs were removed. `runs/` now holds 72 MB of logs.
- **Credentials:** `postgres-fixture.env` was read only by the harness, and its contents were never printed. indexd's
  own pgx errors in early logs name the fixture's database user, but never its password.
- **Status file:** `storage-real-indexd/STATUS.txt` reads COMPLETE.

## 7. Source and binary hashes

**Main tree** (`work/enclave-apps-sia-recovery/sia-s3`; it was not changed by this task):

| File | sha256 |
| --- | --- |
| `replica.rs` | `e45eb2f0e3fe0e39…` |
| `store.rs` | `225c09b42eed019f…` |
| `main.rs` | `ed6abf7f587319c6…` |
| `config.rs` | `0926f0cf0402b9fb…` |

The only main change in this session was earlier: the reviewer-requested F1 fix plus the G1 and F1 tests, 67/67
native. The reviewer accepted it (R2).

**Isolated, tested** (full list in `storage-real-indexd/logs/final-sources.sha256`):

| File | sha256 (prefix) |
| --- | --- |
| `bin/harness` (stock indexd) | `a69daf18cf45c154` |
| `bin/harness-u1` | `d2bed640b97156ce` |
| `bin/sias3-real-driver` | `1a10c22b53253e0a` |
| `indexd-u1.patch` | `4bc1e0a8dbdc2470` |
| `sia-s3/src/store.rs` (U1) | `74528a6b9c974cc1` |
| `sia-s3/src/replica.rs` (+ U1 test) | `4cea7ed00fe46e7c` |
| `sia-s3/src/real_indexd.rs` | `750fea3bc2a0703f` |
| SDK `sdk.rs` | `ed289747a50d5c48` |
| SDK `app_client.rs` | `c012244c7906e1f2` |
| SDK `http.rs` | `9247f9baff2790d2` |
| SDK `app_client/mock.rs` | `0b853c83b380bd6b` |
| SDK `mock.rs` | `256b01b7383ba8a6` |

The harness's copy of indexd's `testutils` (`harness/rtu`) and its changes are listed with hashes in the same file.
`harness/rtu/PROVENANCE.txt` records the copied files' original hashes.

## 8. Remaining gates

1. **U1 is fixed only in isolated copies.** It needs:
   - a decision on the indexd API contract (this endpoint, or the fencing revision's seq listing), and an owner for
     the indexd change;
   - then the SDK change, and integrating `fetch_index`'s current listing into the main tree;
   - then the main native suite and these real runs again.

   Until then the main tree's boot and re-read listings can miss acknowledged pins (shown above).
2. **Writer fencing (W1) is not approved.** The one-writer requirement and the cutover drain in section 5 stand.
3. **Repair-driven unpublishing** (`RecordSlabMigrated`, unblock) has not been exercised live. The harness disables
   migrations.
4. **No live Sia evidence:** host retention, funding, renewal, network timing.
5. **Reviewer items still open:**
   - D1 docs (import procedure);
   - D2 (part variant at load);
   - G2 (the mutants were not re-run on the final main hashes).
