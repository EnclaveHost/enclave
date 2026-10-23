# Whole-bucket Sia cold recovery (RESULT, 2026-10-22)

**Status: source-only candidate, committed locally and tested offline.**
- NOT deployed, NOT activated, NOT released (no WASM build or release), NOT pushed.
- No SSH, network, Sia or RPC reads. No private seed, snapshot or archive content was read.
- The source worktree `work/enclave-apps-sia-recovery` was never edited.
- Root runs any live verification.

## Source

| item | value |
|---|---|
| repo | `repo/`: `git clone --no-hardlinks` of `work/enclave-apps-sia-recovery`, branch `work/whole-bucket-restore`, origin removed |
| base | `54818ba68ea0feddec1cae5650230ddf2fec3d30`, recorded with the excluded dirty files in `SOURCE-MANIFEST.json` (`572c3b24…`) |
| commit | **`e8f0997f97826d31abd83cf2261bec45aad53f65`**, tree `cc04a22ecf9035f0a87355eb9d568a27336098f4`, author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| changed | `sia-s3/src/recovery.rs` only: `43609c73…` → **`7d2c1d413b0955a4253bccddaf1c24e0a409dbb166e8d6281004e3ef3e2fbe8b`** (+495/−13, of which ~240 lines are tests) |
| patch | `whole-bucket-restore.patch` = `git diff 54818ba e8f0997f`, sha256 **`77ce150061acadd5031fded1a5f8872e1157bfa3f2778f58a746f6441c239235`** |
| plan | `INITIAL.md` (`93c12a62…`), written before the change; it states the integrity model |
| runner | `run-tests.sh` (`b5bfdd90…`) |

## What was added

**The command:**

```
SIA_RECOVERY_KEY_FILE=... sia-s3 recovery restore SNAPSHOT SHA256 NEW_OUTDIR MAX_TOTAL_BYTES DEADLINE_SECS [EXPECTED_INVENTORY]
```

It uses the existing trusted snapshot, the AppKey and `RecoveryReader` directly. The indexer and the SDK upload path are
never used.

**1. Before anything is written:**
- `open_snapshot` runs unchanged: the external SHA-256, the app-key-sealed and signed objects, v1 and v2, and the
  duplicate and incomplete-multipart refusals.
- **Every** v2 manifest key is resolved over RHP4 through the shared helper `manifest_key`. This is the same code
  `recovery read` now uses, with the same refusals: the signed length/SHA-256 and `qkey`, and the data objects present
  and complete.
- A duplicate (bucket, key) is refused.
- The whole restore is refused with nothing written on any of these:
  - a manifest that cannot be read or does not match;
  - an expected inventory that is malformed or has duplicates;
  - a total size above `MAX_TOTAL_BYTES`;
  - a deadline outside 1..=7 days;
  - an existing `NEW_OUTDIR`, in any form.

**2. Per key, in (bucket, key) order:**
- The bytes are streamed through a 256 KiB buffer (`max_buffered_chunks` 2) into a create-new temp file.
- The size must match the signed metadata exactly, and the signed ETag is checked (see the integrity model below).
- The file is hard-linked to `objects/NNNNNN.bin` by the existing `Pending`, so it never overwrites. A file that
  appears there first is a failure, and the other file is kept.
- Each key has a timeout at the shared deadline. Keys the deadline does not reach are listed in `notAttempted`.

**3. Names are data, never paths.** Bucket and key names appear only as JSON strings in `inventory.json`, so traversal,
absolute paths, NUL and NFC/NFD look-alikes have no filesystem effect. Both directories are created new with mode 0700.

**4. Honest outcome.** `inventory.json` (format `sia-s3-recovery-restore/v1`) is written atomically and lists:
- per file: bucket, key, file, bytes, source (inline/manifest), etag, `etagCheck`, `outputSha256`,
  `independentSha256`, contentType, lastModified;
- `failed` (with reasons), `notAttempted` and `expectedButAbsent`.

`complete` is true only if every key was restored and nothing failed. Otherwise the command exits non-zero with
"restore incomplete: …", and keeps only the files that passed verification.

**5. Unchanged:** `recovery read` and `recovery export` keep their exact interface and checks, apart from the
manifest-to-key code moving into the shared helper. The `read` tests still pass.

## Integrity model (as reported, never overstated)

| what | verified by |
|---|---|
| snapshot | the operator-supplied SHA-256, and app-key-sealed, signed metadata |
| key list, sizes, ETags | the signed metadata (v1/v2 inline); v2 manifests are checked against signed length + SHA-256 + `qkey` |
| object bytes | the SDK: RHP4 sector reads are verified against the sealed object's slab commitments |
| `etagCheck: md5` / `multipart-md5` | the MD5 of the body, or `md5(part MD5s)-N` with one data object per part, equals the signed ETag. This is a **consistency check bound to signed metadata, not a collision-resistant hash**. It matches every writer in both the deployed 446ac5f lineage and 54818ba: put, multipart complete, import (MD5 of the fetched bytes), copy and `copy_version` |
| `etagCheck: unverifiable` | the ETag has another form, or N differs from the object count. The key is restored but NOT claimed as ETag-checked |
| `outputSha256` | **computed** over the written bytes. It is not an independent expectation |
| `independentSha256: matched` | only for keys listed in an operator-supplied `sia-s3-recovery-expected/v1` inventory (bucket, key, bytes, sha256). A listed key with another size or hash fails; a listed key missing from the snapshot is reported in `expectedButAbsent`. Every other key is `not-provided` |

## The actual gap (reported, not papered over)

- **Whole-bucket listing and restore needed no new metadata.** The sealed snapshot already names every key (inline), or
  commits to its manifest (v2), together with its size, ETag and the content commitments. So no new export format was
  needed, and none was added.
- **No independent per-file SHA-256 exists anywhere in the signed metadata.** A restored file's SHA-256 can only be
  checked against a record kept outside Sia, such as root's own inventory, or the CIDs for content-addressed keys. The
  restore therefore reports the SHA-256 as computed, and accepts such a record through `EXPECTED_INVENTORY`.
  - Generating that record from the same snapshot would be self-referential, so no such generator was added.
- **Production snapshots are v1.** The pinned binary `bcb2025e` was built from 446ac5f. This candidate reads them, and
  the tests confirm v1 output.
  - Restoring today's exports needs a NEW recovery binary built from this commit. Its build and its hash pin are root's
    decision. The pinned binary has no `restore`.

## Tests

Every run went through `work/claude-test-queue.py --mib 1536` and `run-tests.sh`:
`cargo test --offline --locked --target x86_64-unknown-linux-gnu -j 4`, in `unshare -rn` (no network), with a hard
`timeout`. Logs are in `logs/`.

| run | tree | result | peak |
|---|---|---|---|
| base-2 | 54818ba | 6/6 `recovery` | 1426 MiB |
| **final-2** | **e8f0997f** (forced rebuild) | **40/40, the whole crate** (10 `recovery`: the 6 existing + 4 new), `--test-threads=1`, 36.6 s | 1426 |
| crate-2 | 74a33e48 (pre-amend, same code minus one `#[cfg_attr]` line) | 40/40 | 1426 |
| wasm-check-2 | e8f0997f, default target `wasm32-wasip2` | `cargo check` clean, 0 warnings (wasm-check-1 found an `unused_mut`, fixed) | 1390 |
| m-etag-1 (`logs/m-etag.diff`) | the body's MD5 check disabled | FAILS `restore_reports_partial_failure_honestly` (the ETag case) | — |
| m-sha-2 (`logs/m-sha.diff`) | the expected-inventory SHA-256 check disabled | FAILS at the expected-inventory assertion | — |

**The new tests** (MockNetwork, 12 hosts, (3, 9) shards; the indexer is taken OFFLINE before every restore):
1. **`restore_v1_recovers_every_key_with_names_as_data_never_paths`**
   - A version-1 snapshot. Keys: `pins/bafy1`, `../../etc/passwd`, `/abs/path` (empty), `a\0b`, `café` NFC and NFD, and
     a 3-part multipart key.
   - Every key is byte-exact, with `md5`/`multipart-md5` and `not-provided`.
   - Only `objects/NNNNNN.bin` plus the inventory exist; a second run into the same directory is refused.
2. **`restore_v2_resolves_every_manifest_key_over_rhp`**: a version-2 snapshot, adding a 16-part manifest key and a
   1005-byte key name. Every key is resolved over RHP4 and restored.
3. **`restore_refuses_before_writing_anything`**: nothing is created on any of:
   - a wrong AppKey, a wrong snapshot hash, a tampered sealed object;
   - a tampered manifest commitment;
   - an over-budget total, a zero deadline;
   - a duplicate in the expected inventory.
4. **`restore_reports_partial_failure_honestly`**:
   - **no hosts (missing parts):** every non-empty key fails, and no temp file is left;
   - **a body that differs from its signed ETag:** that key fails, and the rest are restored;
   - **an expected inventory:** matched, mismatched, and listed-but-absent;
   - **a racing file** at an output path: it is kept, and that key fails;
   - **the deadline:** the restored and not-attempted counts add up to all keys.

   Each case exits non-zero, with `complete: false`.

**Two harness findings (not code defects):**
- **Run serially.** With `--test-threads=4` the run stalls until the timeout (`cand-1`, `par-2`).
  - Each new test holds up to ~1.38 GiB of in-memory mock sectors: (3, 9) means 12 × 4 MiB sectors per object. So four
    at once exceed the 1536 MiB cgroup cap.
  - The SDK's 99.99 % recovery floor allows no smaller layout: (1, 2) is refused (`par-3`).
  - Serially, the whole crate peaks at 1426 MiB, the same as the base.
- **Force a rebuild.** Several trees share one `CARGO_TARGET_DIR`, and cargo compares mtimes. So a cloned mutant once
  reused the previous binary (`m-sha-1` never compiled). `run-tests.sh` now `touch`es `recovery.rs`, and every
  reported run shows its own `Compiling sia-s3` line.

## For root (live verification, later)

1. **Build.** Build a recovery binary from `e8f0997f` (x86_64, offline, `--locked`) and record its sha256 as the new
   pin. It reads the existing v1 exports, and v2.
2. **Restore.** Run `recovery restore <snapshot> <its sha256> <NEW dir> <budget> <deadline> [expected.json]` on the
   workstation, with the key file.
3. **Check.** Read `inventory.json`:
   - `complete`;
   - any `unverifiable` ETags;
   - `independentSha256` (only where your own record was supplied).

No production restore, WASM release, Sia write or spend is implied by this candidate.
