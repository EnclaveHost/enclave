# Storage workstream (sia-s3): result

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave-apps-sia-recovery`, branch `decentralize/sia-recovery`,
base `446ac5f`. Changes are uncommitted in the working tree, all under `sia-s3/`. Nothing was committed or pushed.
No secrets, SSH, production calls, transactions or deployments. `s3-ipfs-adapter` and the other checkouts are untouched.

## What was there

- sia-s3 0.1.8 has one indexer as the sole write authority. Every PUT, copy, delete and multipart operation pins to
  `https://sia.enclave.host` (nan's indexd and PostgreSQL), and the index is rebuilt from that indexer's object feed.
- `446ac5f` added read-only recovery from a pinned snapshot, with no indexer involved (`recovery export` / `recovery read`).

## Investigation (what the SDK and indexd really allow)

- **SDK has no contract or wallet path.** `vendor/sia-sdk-rs/sia_storage` (`Sdk`, `Builder`) can upload, download,
  pin, delete and list objects, list hosts, read the account and share. It has no API for wallets, contract
  formation, renewal or account funding. App keys are admitted by an indexer: `Builder::connected`, or the
  connect/register flow. An app that owns its own Sia contracts cannot be built on this SDK.
- **The indexer owns everything that keeps data alive.** In indexd v0.6.0 (read-only source at `work/indexd`, ddaf24b),
  the indexer holds the contracts, renews them from its own wallet, funds the app's host accounts, pins slabs into
  its contracts, repairs slabs, and keeps the object list. Moving indexd or PostgreSQL to another machine moves that
  authority; it does not remove it.
- **Metadata cap.** indexd stores at most 1024 bytes of sealed object metadata (`slabs.MaxMetadataSize`). Sealing
  adds 40 bytes (24-byte nonce plus 16-byte tag). The indexer also refuses objects without data. Together these rule
  out a separate tombstone or ledger object and shaped the delete design below.
- **No cross-indexer sharing.** Object IDs come from the slabs, and slabs are pinned in one indexer's contracts. Each
  replica must therefore upload its own copy.

So the largest sound step at source level is to make the indexer one of N interchangeable replicas, each with
independent contracts, funding and hosts. Writes then need only a quorum of indexers, not one named operator.

## What was implemented (sia-s3 0.2.0)

**`src/replica.rs` (new): the cluster over N independent indexers.**

- **Versions.** Every write is stamped with `h` (a millisecond clock that only moves forward, started past every
  version loaded) and `i` (a random write id). The merged view takes the newest version of each key; a newer
  tombstone hides it.
- **Quorum writes** for PUT (buffered and streamed), CopyObject, UploadPart, CompleteMultipartUpload and DELETE,
  with `writeQuorum` W:
  - Uploads run against all loaded replicas concurrently. A streamed PUT is teed, and a failing replica is dropped
    from the tee.
  - If fewer than W replicas store an upload, it is discarded everywhere before anything is committed.
  - A request that falls short of W answers 503 `ServiceUnavailable`.
- **Boot quorum.** The app serves once N - W + 1 replicas are loaded, so every acknowledged write is visible.
  Replicas load independently with backoff, and late ones are merged when they arrive.
- **Conditional PUT** (`If-None-Match: *`, `If-Match`) is checked against the merged view, and again under the write
  lock at commit.
- **DELETE never resurrects.**
  - The key's entry becomes a tombstone inside its own host object on each replica that held it.
  - The DELETE succeeds only when the tombstone is on W replicas, or when no replica that could still hold an older
    version is unaccounted for. Otherwise it answers 503.
  - A retry re-applies the same tombstone where it is still missing.
- **Failover reads.** Any replica holding the exact version can serve it. On failure, even mid-body, the read moves
  to the next replica and resumes at the first unsent byte. Before sending headers, GET checks that some replica can
  serve the range.
- **Repair (anti-entropy)** runs every `repairEverySecs`:
  - Applies missed deletes.
  - Copies the newest version to replicas that lack it, up to `repairMaxBytesPerPass` per pass. The copy is checked
    for size, and for MD5 on single-part ETags. If the key changed meanwhile, the copy is dropped.
  - Only when every configured replica is loaded, collects tombstones that no live older version survives.
- **Status.** Per-replica `loaded`, `behind`, `tombstonedKeys` and last error appear on `/healthz` and `/api/status`.
  Error strings exclude key names.

**`src/store.rs` (one indexer, refactored into replica primitives).**

- Version-aware load: the newest version wins, a tombstone hides older duplicates, and objects holding tombstones
  are kept out of the orphan sweep and out of compaction.
- New primitives: `commit_entry`, `copy_entry`, `tombstone`, `drop_tombs`, `ensure_upload`, and versioned
  `complete_upload`.
- `MAX_META` guard: metadata the indexer would refuse becomes 400 `EntityTooLarge` instead of an opaque 500.

**`src/config.rs`.**

- `replicas: [{name, indexer, appKey}]`, or one `$SIA_REPLICAS` secret holding that JSON array, so the owner can
  change the set without a catalog publish.
- `writeQuorum` (default: a majority), `repairEverySecs`, `repairMaxBytesPerPass`.
- Refused configs: duplicate indexer URLs (one operator counted as two votes), duplicate names, W outside 1..N, a
  replica key that does not resolve (never a fallback to another indexer's key), and non-http(s) URLs.
- A 0.1.x config is exactly one replica.

**`src/main.rs`, `src/s3.rs`.**

- Each replica has its own boot loop. Compaction runs per replica, and the repair loop only when N > 1.
- The S3 surface, SigV4 auth and SDK encryption are unchanged.
- New error mappings: 503 `ServiceUnavailable`, 400 `EntityTooLarge`.
- `?sia-diag&replica=<name>` selects which indexer's hosts are probed.

**`src/import.rs`.**

- `import <bucket> <manifest> <replica>`, required when several replicas are configured.
- Deterministic versions: the clock comes from `SIAS3_IMPORT_VERSION_MS` and the write id from a hash of
  bucket, key, ETag and size. Per-replica imports therefore converge with no repair re-upload.

**Single-indexer compatibility (N = 1).** DELETE removes the object outright with no tombstone, and repair does
nothing. The only format change is the `h`/`i` stamp, which 0.1.x ignores, so rolling back is safe for one replica.

**Vendored SDK (mock only, `feature = "mock"`).** `MockNetwork::set_indexer_offline` makes the mock indexer fail
every call while keeping its state, which simulates a real outage. This follows the same precedent as the
`recovery_reader` addition in `446ac5f`. No production SDK code changed.

**Docs.** `sia-s3/REPLICATION.md` (new) covers the design, guarantees, what stays centralized, activation needs,
operator procedures, limits and validation. `README.md` was updated.

## Tests (run with `CARGO_BUILD_JOBS=1`)

`cargo test --offline --target x86_64-unknown-linux-gnu`: **22 passed, 0 failed** (7 existing + 15 new, ~56 s).

The replica tests use real encrypted, erasure-coded uploads and downloads (3+9 shards, the smallest layout the SDK
accepts). Each replica is an independent `MockNetwork` with its own indexer, hosts and app key.

- **Outage write and backfill.** A write made while one indexer is offline succeeds. Repair copies it to the
  returning replica, which alone then serves it, after the first replica's indexer is offline and its sectors are
  wiped.
- **Below quorum.** The write answers 503, and the replica that did store the upload keeps nothing.
- **Missed delete.** A boot loading the replica that missed the DELETE still sees the key deleted. Repair applies the
  delete and collects every tombstone (verified by reloading each indexer), and the key can be created again.
- **Refused delete.** A DELETE is refused while its tombstone is short of quorum and an unreachable replica holds the
  key. The retry succeeds once that replica is back.
- **Boot merge.** A boot merges the newest version, `If-Match` against the stale ETag gets 412, repair updates the
  old replica, and the clock orders later writes last.
- **GET failover.** A ranged read fails over when one replica's hosts lost the data, and fails only when both have.
- **Streamed PUT.** It tees to every replica and drops the offline one; `If-None-Match: *` is enforced across both.
- **Multipart and copy.** Multipart (create, parts, complete, list) and CopyObject work, with the same version on
  every replica. The one-indexer DELETE leaves no tombstone, and repair does nothing.
- **Unit tests.** Config acceptance and refusal, legacy ordering, import write ids, and the metadata budget.

`cargo check` for `wasm32-wasip2`: clean, no warnings. Release wasm build: see the end of this file.

## What is still centralized, and what activation requires

Not decentralized by this change:

- **Each replica's indexer operator.** It holds that replica's contracts, renewal, funding, slab repair and object
  list. The SDK offers no path to app-held contracts. Independence comes only from running more replicas under
  unrelated operators. Open participation is implemented (any indexd that registers the app key can be listed), but
  no independent operator exists yet.
- **The sia-s3 deployment itself.** It is one writer with an in-memory view; two concurrent writer instances are
  unsupported, as they were in 0.1.x. Enclave-level failover belongs to another workstream.
- **The owner key.** It signs secrets and catalog versions (Enclave governance).

Activation needs hardware, funds and chain activity. None of it was done:

1. At least one more indexd (v0.6.0, optionally with `indexd/enclave-small.patch`) and its PostgreSQL, run by an
   operator independent of nan. N = 3 with W = 2 is recommended; it survives one outage for both writes and restarts.
2. A Siacoin wallet per indexer, funded for on-chain contract formation and renewal. Today's ~4.7 GB needs about
   14 GB of contracted storage per replica (3x redundancy) plus upload bandwidth.
3. The sia-s3 app key registered on each indexer with quota, which is that operator's action.
4. A sia-s3 0.2.0 catalog publish (owner/Trezor), and a redeploy with the replica list and keys as secrets.
5. The initial repair backfill, a full erasure-coded copy per new replica. Monitor `/healthz` → `replicas[].behind`.

## Residual risks and findings

- **Not run against live systems.** Nothing ran against real indexd, real Sia hosts, or a deployed enclave. The mock
  indexer does not enforce the 1 KiB metadata cap; that limit was taken from indexd source and is now enforced in
  sia-s3 itself.
- **Multipart part limit.** Because of the metadata cap, a multipart key is limited to about 12 parts at a short key
  (13 before this change; the version stamp costs 37 bytes). The file explorer uploads files over 48 MiB in 40 MiB
  parts, so uploads above roughly 480 MiB would fail at Complete. This was found in code and not verified live.
  sia-s3 now answers 400 `EntityTooLarge` there instead of an indexer 500. A real fix needs a manifest that is not
  stored in one object's metadata.
- **Indeterminate writes.** A write that answered 503 after partially committing may become visible, as after an
  S3 500. A retried `If-None-Match` create can then get 412.
- **Repair storage cost.** Repair turns shared objects (copies, packed small files) into one object per key on the
  repaired replica, and multipart keys into single objects. A deleted key's data stays pinned until every
  configured replica confirms the delete.
- **Re-adding an old replica.** An indexer account that was removed must not be re-added without wiping it (use a
  fresh app key). Tombstones are collected once every configured replica is loaded, so its stale keys could return.
- **Rolling back.** Rolling a replicated deployment back to 0.1.x is unsafe: it would sweep objects that hold only
  tombstones.

## Files changed

`sia-s3/src/{replica.rs (new), store.rs, s3.rs, main.rs, config.rs, import.rs, recovery.rs}`,
`sia-s3/{REPLICATION.md (new), README.md, Cargo.toml (0.2.0), Cargo.lock (sia-s3 version line only)}`,
`sia-s3/vendor/sia-sdk-rs/sia_storage/src/{mock.rs, app_client/mock.rs}` (mock-only outage switch).

## Release build

`CARGO_BUILD_JOBS=1 cargo build --offline --release` (wasm32-wasip2) succeeded:
`sia-s3/target/wasm32-wasip2/release/sia-s3.wasm`, 3,853,746 bytes,
sha256 `a29df41eeed6e29e810c33a2f0689bfdd9d8fd8c8b79550135330d55cbc294c4`. This is a local build of uncommitted
source. It has not been published, pinned or deployed; rebuild from a clean commit before any publish.
