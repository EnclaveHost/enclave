# sia-s3 test memory: a disk-backed mock, and the unmutated native baseline (2026-10-19)

**Repository:** `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave-apps-sia-recovery/sia-s3`

**Outcome.** The complete unmutated native suite passes: **36/36** in 22 s, with one build job and one test thread, under
a cgroup capped at **MemoryMax=1024M, MemorySwapMax=0**.

**What was not done.** No mutations, commits, production changes, SSH, Wine, GUI or chain writes. Production `src/` is
byte-identical except for the test module of `src/replica.rs`, and that is proven below.

## Why it OOMed before

The vendored SDK mock host transport (`vendor/sia-sdk-rs/sia_storage/src/rhp4/mock.rs`) kept every sector in RAM, in a
`HashMap<PublicKey, HashMap<Hash256, Bytes>>`.

Every object the tests pin is a full 12-shard slab of 4 MiB sectors (3+9), really encrypted, erasure-coded and
root-hashed by the SDK. `many_part_uploads_and_long_keys_use_manifests_everywhere` pins dozens of objects on two
indexers, so it held well over 2 GiB. That matches the coordinator's cgroup OOMs at 768 MiB, 1536 MiB and 2 GiB, which
were OOMs and not assertion failures.

## What changed (test-only)

### `vendor/sia-sdk-rs/sia_storage/src/rhp4/mock.rs`

The storage is now `enum Sectors { Memory(..), Disk(..) }`.
- **`Memory`** is the default and is the original code moved into a method. Its behaviour is unchanged, including the
  slice panic on an out-of-range read.
- **`Disk`** (native only, `cfg(not(target_arch = "wasm32"))`) is `DiskSectors`:
  - It creates a fresh directory under a caller-given base, named `sia-mock-sectors-<pid>-<nanos>-<counter>` and created
    with `create_dir`, never `create_dir_all`. A name collision retries with the next counter, up to 16 times.
  - Files are `<hex host key>/<hex sector root>.sector`. Both names are hex of validated 32-byte binary values (the
    host's `PublicKey`, and the root the transport computed from the bytes). No caller string reaches the filesystem,
    and only files this store wrote are ever read or removed.
  - **Write:** a sector already held is a no-op (content-addressed). Otherwise the byte budget is checked, the data goes
    to `File::create_new(<root>.part)` with `write_all`, and is renamed. On error the `.part` file is removed and the
    write FAILS: nothing is dropped silently.
  - **Read:** "host not found" or "sector not found" exactly as the memory store reports them. A range outside the
    sector is an error, not a panic. Otherwise the file is opened, seeked and `read_exact` for exactly the range.
  - **`clear()`:** deletes exactly the recorded files and resets the byte count.
  - **`Drop`:** clears, then `remove_dir` on each host directory and on its own directory. Nothing is removed
    recursively; failures are reported on stderr, never with a panic.
- New `Client::with_disk_sectors(base, limit)`, plus `sector_dir()` and `sector_bytes()`.

### `vendor/sia-sdk-rs/sia_storage/src/mock.rs`

`MockNetwork::with_disk_sectors(base, limit)`, `sector_dir()` and `sector_bytes()`, all native only. `MockNetwork::new()`
is unchanged and is still the default.

### `src/replica.rs`, `#[cfg(test)]` module only

- `sector_base()` returns `<crate>/target/mock-sectors`, on the encrypted root disk (not tmpfs; 479 GB free).
- `Net::on_disk(seed)` / `on_disk_with(seed, limit)`.
- A new test, `disk_and_memory_mock_sectors_answer_alike`.
- `many_part_uploads_and_long_keys_use_manifests_everywhere` now uses `Net::on_disk`. Its 16 parts, two replicas, `W=2`,
  manifests, copies, reload, deletes and floor assertions are untouched.

### Docs

- `REPLICATION.md`: new section "Test memory: the disk-backed mock".
- `vendor/sia-sdk-rs/UPSTREAM`: a note on the local test-only change.

### Production isolation

The mock module exists only under `cfg(any(test, feature = "mock"))`, and sia-s3 enables `mock` only through
`[dev-dependencies]`. `cargo tree --target wasm32-wasip2 -e normal,features` shows `sia_storage` with only `default`, and
zero `"mock"` features. The disk code is also compiled out on wasm32.

## Fidelity review

- **Byte fidelity.** The SDK path (encryption, erasure coding, sector roots, and the download path's own checks) is
  unchanged. Only where bytes rest changed: the same `Bytes` are written whole and read back as the exact range
  requested.
- **Unchanged behaviour.** Fault injection, slow hosts, read failures, read delays, price faults and `clear_sectors` all
  behave the same.
- **Memory limits.** Memory is bounded per test; the sector bytes in flight for one write remain in RAM, as with any
  transport.
- **Leaks.**
  - After every disk-backed run in this session, `target/mock-sectors/` was empty.
  - The equivalence test asserts its directory is gone after drop.
  - A process killed outright (e.g. by a cgroup OOM) cannot run `Drop`. Stale directories stay under
    `target/mock-sectors/`, named by pid; there is no automatic sweep, and none appeared here.
- **Not changed.** Production `src/store.rs` and the non-test part of `src/replica.rs` are untouched.

## Tests

### `disk_and_memory_mock_sectors_answer_alike`

It drives the real SDK through each backend:
- complete bytes of a 300 KB object;
- ranges `0+1`, `1+4095`, `4096+60000`, `299999+1` and `123457+100000`;
- on disk, only `<64 hex>/<64 hex>.sector` files of exactly 4 MiB, inside the store's own directory, summing to
  `sector_bytes()`;
- after `clear_sectors()`, the identical read error from both backends, and `sector_bytes() == 0`;
- a 4 MiB budget making a put fail;
- directory removal on drop.

It passed under 768 MiB.

### `many_part_uploads_and_long_keys_use_manifests_everywhere`

On the disk backend it passed alone in 5 s under **768 MiB**. It previously OOMed even at 2 GiB.

## Baseline runs

All runs used `cargo test --offline --target x86_64-unknown-linux-gnu -- --test-threads=1`, `CARGO_BUILD_JOBS=1` and
`MemorySwapMax=0`.

| Cap | MemAvailable at start | Result | Log |
| --- | --- | --- | --- |
| 768M | 17,973 MiB | cgroup OOM (exit 143) after 1 s, on `recovery::tests::manifest_keys_recover_from_a_cold_snapshot_with_no_indexer` | `work/storage-unmutated-768MiB-recovery-oom.log` |
| 1024M | 17,830 MiB (≥ 16 GiB floor + 1024 + 256) | **36 passed, 0 failed**, 22.14 s, exit 0 | **`work/storage-unmutated-final.log`** |

**About the 768M failure.** The recovery-module test still uses the in-memory mock. It is not in the files I was allowed
to edit (`src/recovery.rs`), so I did not switch it to the disk backend. The cap was raised only once, to 1024M, because
the measured headroom permitted it. 1536M was not used, because headroom was below 16 GiB + 1536 + 256 MiB.

To run the whole suite at 768M:
- **Change:** switch the recovery tests' `MockNetwork::new()` to `MockNetwork::with_disk_sectors(..)`, a two-line,
  test-only change in `src/recovery.rs`.
- **Status:** not done; it needs authorization to edit that file's test module.

**Log checks.**
- The log holds no `MUTATION` or `MUTANT` markers.
- The source holds no mutation markers.
- No `.part` or sector directories remained afterwards.

## Source hashes

Before (`work/storage-hashes-before.txt`) and after (`work/storage-hashes-after.txt`).

**Unchanged:**

| File | sha256 |
| --- | --- |
| `src/store.rs` | `94c4e445…` |
| `src/config.rs` | `5a526e19…` |
| `src/diag.rs` | `ea7021dd…` |
| `src/http.rs` | `46686e51…` |
| `src/import.rs` | `bf3b8b59…` |
| `src/main.rs` | `f3f8b876…` |
| `src/recovery.rs` | `43609c73…` |
| `src/s3.rs` | `a84be65e…` |
| `src/sigv4.rs` | `6ee15cba…` |
| `vendor/…/app_client/mock.rs` | `5fd57ccc…` |
| `Cargo.toml` | `13dcc43e…` |
| `README.md` | `7dc32f55…` |

**Changed, test or docs only:**

| File | Before | After |
| --- | --- | --- |
| `src/replica.rs` | `3b7e300a…` | `e598ae82…` |
| `vendor/…/rhp4/mock.rs` | `bb516f3b…` | `59939c82…` |
| `vendor/…/src/mock.rs` | `c6cf179d…` | `b0800a73…` |
| `REPLICATION.md` | `5b6bdba7…` | `996bcf57…` |
| `vendor/sia-sdk-rs/UPSTREAM` | (not in the before set) | `2e9645e5…` |

**Proof that the `src/replica.rs` change is test-only.** Removing exactly my test-module edits (the helpers, the new
test, and the multipart test's `Net::on_disk` line) gives back a file whose sha256 is the before-hash `3b7e300a…`, byte
for byte.

## Preserved

These earlier fixes are untouched:
- the compact tombstone floors;
- the lost-response and late-delete tests;
- manifests;
- URL redaction.

Redundancy is unchanged (3+9 shards, two replicas, `W=2`), and no data is deleted early.

## Remaining gates

1. The full suite at 768M still needs the recovery tests moved to the disk backend (test-only, `src/recovery.rs`; not
   done).
2. Production wasm must still be built from a committed, clean checkout; nothing was built or published for production
   here.
3. Nothing is committed. The vendor mock changes are local, recorded in `UPSTREAM`.
