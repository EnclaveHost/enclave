# Whole-bucket Sia cold recovery (INITIAL, 2026-10-22)

**Scope:** finish the existing indexer-free cold-recovery path (`sia-s3 recovery`), not a new architecture.
- Source only, in an isolated clone. No live SSH, network or Sia reads; no private seed or snapshot content.
- No production activation, WASM release or spending. Root runs any live verification later.
- No `AGENTS.md` exists in the source repo, its worktrees or the workspace above them (searched).

## Source base (SOURCE-MANIFEST.json)

- **Clone:** `repo/` = `enclave-apps` at **`54818ba`**, branch `work/whole-bucket-restore`, no remote.
- **Source worktree:** `work/enclave-apps-sia-recovery` is never edited. Its six dirty files are unrelated replication
  work and are NOT copied (their hashes are recorded).
  - Its `recovery.rs` is byte-identical to `54818ba`.
- **Why `54818ba`:**
  - The pinned recovery binary `bcb2025e` was built from `446ac5f` and has no manifest support, so today's production
    exports (10-19, 10-22) are **snapshot v1**.
  - `54818ba` reads v1 AND v2 (manifest keys).

## The gap

`recovery read SNAPSHOT SHA BUCKET KEY OUT EXPECTED_SHA256 EXPECTED_BYTES` recovers ONE key.
- It needs its name, SHA-256 and size from a separately trusted record. Key names are sealed in the snapshot, and there
  is no list or restore-all operation.
- A complete per-key inventory does not exist anywhere, so whole-bucket recovery after indexer loss is impossible
  today.

## Integrity model: what is verified, and by what

1. **Snapshot.**
   - The caller supplies its SHA-256 from a trusted record (unchanged).
   - Every object is a `SealedObject`: its metadata is encrypted AND signed under the app key. `open()` fails on another
     key or any tamper (unchanged).
2. **Object bytes.**
   - The SDK `RecoveryReader` reads sectors over RHP4 from the snapshot's hosts. It verifies them against the sealed
     object's own slab and sector commitments.
   - This is the primary integrity guarantee for content, and it is SDK-verified, not computed by us.
3. **Key identity, size and ETag** come from signed metadata:
   - **inline keys (v1 and v2):** `Entry {b, k, s, t, …}` inside the sealed object metadata;
   - **manifest keys (v2):** the signed `MfRef {q, n, z}` commits to the manifest body's length and **SHA-256**. The body
     (`b, k, s, t, x`) is read over RHP4, then must match `n`/`z` and `qkey(b, k) == q`.
4. **ETag.** Every write path sets ETag = MD5 of the exact body (single part), or `md5(concat(part MD5s))-N` (multipart,
   one data object per part). This is the same rule `replica.rs` copy_version already uses for repairs.
   - The restore computes the MD5s while streaming and refuses a key whose ETag differs.
   - When the ETag cannot be checked (multipart with N ≠ its object count, or a non-MD5 form), the key is restored and
     reported as `etag: "unverifiable"`, never as verified.
   - **MD5 is a consistency check bound to the signed metadata, not a collision-resistant independent hash.**
5. **SHA-256 of each output: COMPUTED, never claimed as independently expected.**
   - The signed metadata carries no whole-file SHA-256 for a key, so the restore reports `outputSha256` as computed over
     the bytes it wrote.
   - An independent expected SHA-256 is claimed ONLY when the operator supplies an expected inventory (a separately
     trusted record, as `read`'s EXPECTED_SHA256 is today). Then every listed key must exist and match size and SHA-256,
     or the key fails.

## Planned change (smallest; `sia-s3/src/recovery.rs` only)

**New command:** `recovery restore SNAPSHOT SHA256 OUTDIR MAX_TOTAL_BYTES DEADLINE_SECS [EXPECTED_INVENTORY]`.
- **Resolve everything first:**
  - open the snapshot exactly as `read` does (v1 and v2, the same duplicate and completeness refusals);
  - then read and authenticate EVERY manifest over RHP4;
  - any unreadable, mismatched or duplicate one refuses the whole restore before anything is written.
- **Budgets:**
  - the sum of all key sizes must fit `MAX_TOTAL_BYTES`, refused up front;
  - each key streams with bounded buffers;
  - `DEADLINE_SECS` is checked per key (bounded per-key timeout). Keys not reached are reported, never skipped silently.
- **Output:** a NEW directory only. `OUTDIR` must not exist; it is created 0700.
  - Data goes to `objects/NNNNNN.bin` (sequence numbers in (bucket, key) order).
  - **Bucket and key names never become filesystem paths:** no traversal, NUL or Unicode-collision surface. They are
    recorded as JSON strings in `inventory.json`.
  - Each file is written to a create-new temp and hard-linked into place (the existing `Pending`), so nothing is ever
    overwritten.
- **Honest outcome:** `inventory.json` (written atomically) lists, per key:
  - bucket, key, file, bytes, ETag and its check;
  - `outputSha256` (computed) and the independent-hash status;
  - source (inline/manifest), content type, mtime;
  - every failure with its reason, and every key not attempted.

  `complete: true` only when every key was restored and verified. Otherwise the command exits non-zero ("restore
  incomplete") while keeping the verified files.
- **Preserved:** `recovery read` and `recovery export` keep their exact interface and checks. The manifest-to-key
  resolution is shared through one helper, with the same refusals.

## Tests (planned; MockNetwork, the existing pattern)

- A v1 and a v2 snapshot each restore every key exactly:
  - several buckets; keys with `../`, absolute paths, NUL, and NFC/NFD look-alikes;
  - a multipart key and a manifest key.
- Refusals with nothing written:
  - a wrong app key, a wrong snapshot hash, a tampered sealed object;
  - a manifest whose signed hash does not match;
  - an existing OUTDIR, a total-size budget exceeded.
- Partial failure, reported and non-zero:
  - hosts unreachable (missing data), an ETag that does not match, an expected inventory mismatch or a key absent from
    it;
  - a destination file appearing mid-restore (race); the deadline.
- Every existing `recovery` test still passes. Queue cap ≤ 2048; only `cargo test` of this crate; no broad builds.
