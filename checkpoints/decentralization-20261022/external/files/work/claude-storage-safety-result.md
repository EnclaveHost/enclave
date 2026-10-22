# sia-s3 storage safety: B2, B3 and L1 fixed in source; not compiled yet (2026-10-20)

**Worktree:** `work/storage-safety-review/sia-s3`, baseline `54818ba`. No commits or pushes.

**Not done:** no production access, SSH, chain, Wine or GUI. B1 (membership and migration, worker `6b7af721`) and B4
(clock reservation) are not mine and are untouched.

**Interface note** (written before the code, now marked implemented): `work/storage-safety-interface.txt`.

**What these fixes are not:** they do not make the system decentralized, and they do not remove the documented
fail-stop, one-writer limits.

## Status, honestly

- **Implemented** in `src/store.rs` (+148), `src/replica.rs` (+201, of which about 150 are tests) and `src/main.rs`
  (+2). `REPLICATION.md` is untouched, to avoid conflicts with the membership worker; proposed text is below.
- **Not compiled and not run.** A `cargo` build of this crate (tokio, reqwest and the Sia SDK, plus 4 MiB-sector mock
  slabs in tests) needs far more than the 250 MiB this task allowed. Reusing the other worktree's `target/` would
  interfere with the active membership worker. So **compile errors are possible**; the commands are below.
- **What was checked here:**
  - all three edited files parse (`rustfmt --edition 2024 --emit stdout`, exit 0, nothing on stderr);
  - every edit was reviewed by hand for types, borrows, lifetimes and lock scope (details below);
  - the SDK's `pin_object`, `delete_object` and `prune_slabs` were confirmed to be lazy `async fn`s
    (`vendor/.../sdk.rs:290, 316, 357`), so refusing before the first poll sends nothing.

## B2: unreadable manifest bodies

**Change (`store.rs`).**

- New `Index::blocking_unresolved()`. It returns the unresolved manifests whose signed `MfRef` version is not matched
  or superseded on this replica. "Superseded" means a resolved live entry of the same key hash at an equal or newer
  version, or a tombstone or floor at an equal or newer version.
- `fetch_index` returns `Err("N manifest(s) of live key versions could not be read")` when that list is non-empty, as
  it already does for unread ledgers. As a result:
  - the replica stays unloaded and `load_replica` retries (5 s up to 300 s);
  - a re-read (`reconcile`) keeps the old index;
  - `import` and `recovery export` refuse too.
- A **dead** unreadable manifest (one with a newer version, or a deletion, above it) does not block the load. It stays
  in `idx.unresolved`, so the orphan sweep stays conservative.
- `purge_dead`, when it clears such a manifest, now also removes it from `idx.unresolved`, so the sweep is not held back
  forever.

**Why this is the fix, and not a weaker claim.** Loaded without the body, the replica:

- counted toward the boot quorum while missing (possibly acknowledged) newest versions;
- served the older version of those keys;
- could delete or move data objects only that manifest names: `drop_parts`, `compact` and `is_part` consult only
  `idx.keys`.

Refusing the load removes all three. The trade-off is availability: with **N=1, one unreadable live manifest keeps the
whole service unready** until its hosts serve it. `/healthz` and the status page then show
`boot: … manifest(s) of live key versions could not be read`. This is the same trade the code already makes for
ledgers.

**Regressions** (`replica.rs` tests, disk-backed mock):

- **`an_unreadable_manifest_of_a_live_version_keeps_the_replica_unloaded`**
  - Key K, 700 characters. v1 is stored inline.
  - v2 needs a manifest (a long content type). Removing v1's old entry hangs (`Fault::Hang` on `delete_object`), so v1
    stays on the indexer; the test asserts this from a fresh listing.
  - The v2 manifest's body hash is then corrupted.
  - **On `54818ba`**, the replica loaded and served the stale `"old bytes"`.
  - **Now** the load returns `Err` mentioning a manifest, a one-replica cluster is not ready, and K is not served.
- **`an_unreadable_manifest_of_a_dead_version_does_not_block_and_is_purged`**
  - v1 (a manifest, made unreadable) and v2 (a manifest), with v1's manifest left behind.
  - The load succeeds with one unresolved and zero blocking, and `"second"` is served.
  - Maintenance purges the dead manifest: it leaves the in-memory index and a fresh listing.

## B3: `reconcile` against changes made through the old store

**Change.**

**`store.rs`:**

- `Store` gains two private fields:
  - `retired: Cell<bool>`, with `retire()` and `is_retired()`;
  - `inflight: Cell<u32>`, with `in_flight()`.
- **`Store::remote()`, the single path for every pin and delete:**
  - **When retired**, it refuses before polling: it sends nothing, marks nothing ambiguous, and returns an error
    containing `RETIRED` ("… was replaced … nothing was sent; retry").
  - **Otherwise** it holds an `InFlight` guard. If the caller's future is dropped before the answer (abandoned by
    `fan_out` or a timeout wrapper), the guard decrements the count and marks the store **ambiguous**. This closes an
    old gap: `abort_upload`'s `fan_out` and the `complete_upload` cleanup timeout used to drop remote calls silently.
- `compact()` skips `prune_slabs` on a retired store.

**`replica.rs`, `Cluster::reconcile`:** after the unchanged listing, write lock and same-store check, it now:

1. tries `old.idx.try_lock()`. If the index is held (by compaction, upload bookkeeping or a sweep), it returns
   `Err("busy …")`. It never waits on the index while holding the write lock, so writes are not stalled for a
   compaction, and the write → index lock order is never inverted, so there is no deadlock;
2. requires `old.changes == before` **and** `old.in_flight() == 0`, else returns `Err`;
3. calls `old.retire()` **synchronously** (no await between the checks and the swap);
4. copies uploads that have no part yet, the ambiguity and the stats into `fresh` (`idx.get_mut()`, no lock), and
   swaps.

An `Err` leaves the replica dirty, and the next maintenance pass retries.

**Coverage of callers that still hold the old `Rc`.** Every durable object change goes through `remote()`
(`pin_with` → `pin_object`, `delete` → `delete_object`); `prune_slabs` is gated separately. The affected callers:

| Caller | Lock | After a swap |
| --- | --- | --- |
| Compaction loop (`main.rs`) | none | its pins and deletes are refused; it stops at the first pin |
| `upload_part`, `abort_upload` | none | refused; the replica's UploadPart fails and the client retries |
| `write_ledger` from DELETE | none | refused; DELETE re-counts on the current stores |
| Floors, reclaim, merge, purge | repair task, sequential with reconcile | refused |
| Sweep | none | refused |

Commits, copies, tombstones and completions hold the cluster write lock, which reconcile also takes. Uploads of
not-yet-pinned slabs are not object changes.

**Regressions** (each fails on `54818ba` as described):

- **`a_re_read_never_swaps_out_a_pin_still_in_flight`**
  - Setup: UploadPart's pin is held with `Fault::Defer`; `reconcile` runs while it is in flight, then the indexer
    applies the pin.
  - **On the baseline**, the swap went ahead, and the fresh index lacked the part without being dirty, so
    CompleteMultipartUpload failed with `InvalidPart`.
  - **Now** the swap is refused, the store is dirty, maintenance re-reads it, and the completion succeeds and serves
    the bytes.
- **`a_re_read_never_waits_on_a_busy_index_while_holding_the_write_lock`**
  - Setup: the test holds the index the way the compactor does.
  - **On the baseline**, `reconcile` waited under the write lock (the 20 s timeout fails the test).
  - **Now** it returns `busy` promptly. After the index is released, a write succeeds and the next reconcile swaps.
- **`a_replaced_store_sends_nothing_more`**
  - After a swap, `write_ledger` and `upload_part` on the old `Rc` fail with `replaced`, in-flight is 0, and the store
    is not dirty.
  - A fresh listing shows no ledger and no part. The current store still uploads, completes and serves.

**Residual.** Under continuous upload traffic, `reconcile` can find the store busy every pass. The replica then stays
dirty and keeps serving its current index, as before the fix, until a quiet pass. A bounded quiesce could follow later.

## L1: signed indexer URLs in public error text

**Change.**

- New `store::redact(s)`, which cuts the query and fragment of every `http(s)://` URL in `s`. The SDK signs each
  request in the query (`sv`/`sc`/`ss`), and reqwest's error text names the URL.
- It is applied in `e2s()` (every SDK error), `Store::remote()`, `Cluster::note()` (per-replica error, `/healthz` and
  the status page) and `main.rs` `load_replica` (boot error, including `connect()`).

**Regression:** `store.rs` `signed_indexer_urls_never_reach_error_text` covers the reqwest-shaped message, several
URLs, a fragment, IPv6, quotes, and `e2s`.

## Hand review (no compiler)

- **`InFlight`:** borrows `&Store`. `Drop` uses `saturating_sub` and `mark_ambiguous`, and `answered` is set before the
  explicit drop on the answer path.
- **`reconcile`:**
  - it uses tokio's `Mutex::try_lock` and `get_mut` on a `let mut fresh`;
  - the guard `old_idx` is dropped before the swap and the `rebuild()` that locks every index;
  - every early return releases both guards.
- **`blocking_unresolved`:** the closure's `&&String` resolves through `objs.get(*id)`, and versions compare by
  reference.
- **`purge_dead`:** `manifest_gone` is computed before `nm` is moved; `retain` compares `String` by reference.
- **Tests:**
  - every Store API used is `pub`: `write_ledger`, `upload_part(&str, u32, Rc<[u8]>)`, `in_flight`, `is_retired`,
    `blocking_unresolved`, `sdk`, `idx`;
  - `Meta`, `MfRef.z` and `Object.metadata` are `pub`;
  - `Fault::{Hang, Defer}`, `push_fault` and `apply_deferred` exist in the vendored mock;
  - the wait loops are bounded (no hang on failure).
- **Existing tests:** none assert `!dirty()`. The guard only marks ambiguity where an answer was really abandoned. No
  existing test holds an index across a `reconcile`.

## Commands for the coordinator (native, bounded, as the earlier 36/36 run)

```sh
cd /home/steven/Documents/Codex/2026-10-18/wo/work/storage-safety-review/sia-s3

# focused first: the new regressions
systemd-run --user --scope -p MemoryMax=1024M -p MemorySwapMax=0 env CARGO_BUILD_JOBS=1 \
  cargo test --offline --target x86_64-unknown-linux-gnu -- --test-threads=1 \
  unreadable_manifest re_read replaced_store signed_indexer_urls

# then the whole native suite (36 before + 6 new = 42 expected)
systemd-run --user --scope -p MemoryMax=1024M -p MemorySwapMax=0 env CARGO_BUILD_JOBS=1 \
  cargo test --offline --target x86_64-unknown-linux-gnu -- --test-threads=1

# the production artifact (default target wasm32-wasip2, .cargo/config.toml)
CARGO_BUILD_JOBS=1 cargo build --offline --release
```

**Proof that the new tests catch the baseline:** run the same focused filter on a scratch checkout of `54818ba` with
only the new test functions (and `corrupt_manifest` and `wide_type`) pasted in, skipping the `redact` test, which needs
the new function. Expect:

- `…live_version_keeps_the_replica_unloaded`: the load is Ok;
- `…pin_still_in_flight`: the swap is Ok;
- `…busy_index…`: the timeout panics;
- `…replaced_store…`: `write_ledger` is Ok.

Each fails.

## Proposed REPLICATION.md text (to merge with the membership worker's edits)

- **Fault model**, after the ledger bullet: "A replica that cannot read the manifest of a key's newest version (its
  hosts are unreachable or its body is corrupt) does not load either. A manifest of a dead version (a newer version or
  a deletion above it) does not block, and maintenance purges it."
- **Unknown outcomes**: "A re-read replaces a replica's index only while no remote call is in flight and nothing holds
  the index. The replaced store refuses every further pin or delete, so a task still holding it changes nothing the new
  index does not know."
- **Configuration**: "Error text on `/healthz` and the status page never includes the query of an indexer URL (the
  SDK's request signatures)."

## Overlap with the membership worker

The interface note lists the touch points:

- `reconcile` keeps its signature and `Err`-means-pending contract. Any per-replica state B1 adds (for example
  "established" or "joining") must be carried into `fresh` in step 4, as ambiguity and stats are.
- A replica refused for B2 is simply not loaded, so it composes with any readiness rule.
- `Cluster::note` now redacts. No other shared function changed signature.
