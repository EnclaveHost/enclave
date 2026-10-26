# Independent SOURCE-ONLY review: `writer-cold-recovery-stage/r3` (2026-10-26 19:33–19:50Z)

## Bytes and evidence
- **Stage:** `SHA256SUMS` sha256 **`320b80b8cadaeaa622717da96522d64460ea1dee0d5372e793fb525088ac280e`**; `sha256sum -c` OK.
  - The patch is `dbe2d1a6…`, the job `636fbc3b…`, PROVENANCE `7874f8cf…`.
  - The job composes r9 → W1 → W2 → W3 → CR2 `e903c224` → **`a4dd62c3`** and asserts every tree; it expects backward-history 13 and writer-history 9.
- **The scratch `/tmp/w6` matches PROVENANCE:**
  - its index tree is **`a4dd62c303e2742dadc2b5fdf9d6d0023e5cd91a`**, computed with a copied index and a private object dir, so nothing was written into `/tmp/w6`;
  - the worktree equals the index;
  - the five touched paths hash exactly as listed: `backward-history.mjs 789d67c9…`, `provider.mjs dcf0f177…`, `derived-writer-authority.mjs 0e98e1b2…`, the tests `33236d5c…` and `c065fb0c…`; `coverage-store.mjs ca9900f5…` is untouched.
- **Read:**
  - `logs/claude-history-r3-repair.md`, the stage's inputs 1569 and 1571, and PROVENANCE;
  - all of `backward-history.mjs` (255 lines);
  - `provider.mjs:215-260`, `:386-415`, `:440-446`, `:481-489`, `:579-631`;
  - `derived-writer-authority.mjs:165-270`, `:296-312`, `:326-360`, `:396-420`, `:505-541`;
  - `vendor/anchor-bootstrap.mjs:64-88`;
  - `op-receipts-root.mjs:130-144`;
  - the test call sites for v2, per-index, concurrency and preflight (grep only; I did not audit every assertion).
- **Not done:** no tests, builds, network, live actions or USB, and no edits to any stage or scratch. **Nothing in r3 has passed yet.** Root's combined run is pending.

## Result: no correctness bug or regression found in the reviewed source paths
Every claim below cites the lines I read.

### F1 coverage-first (`derived-writer-authority.mjs:257-268`)
- **Single anchor (`:304`):** coverage `[from, B]` is read first. If it starts at the ledger floor, or contains any `Claimed`, it is returned and the history is not called.
  - This is equivalent to the full-history replay, because `replayToRow` (`:194-213`) uses only the **last** `Claimed` and everything after it, and coverage runs to the anchor.
- **Released or re-claimed leases:**
  - **Release after a pre-coverage claim:** coverage has no `Claimed`, so the history is used. Its replay sees the release and gives `inconsistent_logs` (`:207`).
  - **History unavailable:** `history_unavailable` (`:246-247`, `:309`).
  - **No history capability:** `covered` is returned, and the replay gives `claim_not_covered` (`:202`).
  - **Re-claim by another runner inside coverage:** the last claim governs, and the runner/operator check is at `:205-206`.
- **Two anchors (`:342`, `:406-417`):** coverage is read through S.
  - A `Claimed` in `(B_f, S]` (including a release + re-claim after B_f) is the last claim → `claim_not_final` (`:410`).
  - A claim ≤ B_f inside coverage replays at B_f over `logs ≤ B_f` (`:415`), and that claim is still there because it is ≥ `from`.
  - When coverage starts after B_f (`from > last`), the history is required, unchanged from r2.

### F6 join hash (`:188-192`)
Every lease log of block `join.number` must carry `join.hash`, else `derived_logs_invalid`.

### F3 absolute chunks and cache (`backward-history.mjs:174`, `:196-218`)
- **Boundaries:** `lo = floor + ⌊(hi−floor)/chunk⌋·chunk`.
- **The top chunk:**
  - a cached **complete** chunk is sliced to `[lo, hi]` (`:202`) and re-hashed **downward from the authenticated N**, so headers above N are never used;
  - only complete fetched chunks are written (`:207`);
  - a verification failure drops the entry and refetches (`:203`, `:206`).
- **Lean entries keep every hashed field:** `HASHED_HEADER_FIELDS` = BASE + `ISTHMUS_FIELDS`, which is **all** `OPTIONAL` fields (`anchor-bootstrap.mjs:64-68`). `verifyBlockReceipts` tolerates the absent `hash` (`op-receipts-root.mjs:143-144`).
- **No false omission:**
  - the floor is inclusive, and `gap` is checked at `:219`;
  - the bloom skip rule is unchanged (`:64-65`);
  - a different floor with the same chunk still names absolute block numbers, so entries remain correct.
- **Untrusted cache reads (`:96-109`):**
  - `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`; `fstat` must show a regular file of this uid, ≤ 4 MiB; the read goes through the fd, with a growth check;
  - only an array of exactly `chunk` entries is returned, and every entry is re-verified;
  - the directory must be private (`:80-82`);
  - `put` uses an `O_EXCL|O_NOFOLLOW` temp file + rename;
  - eviction keeps within `maxBytes`/`maxFiles` and never removes the entry being written (`:113`);
  - the 1571 default is `2 * 1024 ** 3`, bounded to 1 MiB..64 GiB (`:68`, `:78`).

### F2 RAM progress transactions (`:169-172`, `:211-217`; `provider.mjs:221-237`)
- **The progress key** is `[N.number, N.hash, floor, sorted ledgers, chunk]`.
- **Commit point:** `collected`/`expectHash`/`nextHi` change only in one synchronous block after the chunk's headers **and** all its receipt blocks have verified, and after the `maxLogs` check (`:214-217`).
- **`bounded()` (`:131-144`)** awaits every worker before rethrowing, so no task outlives the failure into a retry.
- **Progress is reused only by the retry path** (`scan?.seed === seed`, `provider.mjs:224`), i.e. after the previous scan settled with `error`. A new seed object gets `{}`.

### Ordering and full verification under concurrency (`:210-213`, `:220`, `:233-249`)
- `bounded` stores results **by item index**. Hits are descending, each block's logs are reversed (descending), and the final result is reversed to ascending. **The output is independent of completion order.**
- **Every hit block is fully verified:** `transactionsRoot` from raw transactions → tx hashes → `verifyBlockReceipts` against the authenticated block hash.

### Preflight is a gate, not authority (`:223-232`)
Its results are discarded. A failure is typed `preflight` and retried by `provider.mjs:252` after 60 s.

### Policy v2 and default-disabled
- **`backwardHistoryPolicy` (`:46-55`):**
  - exact 8 keys and v2 format;
  - v1 refused;
  - `rawTransactions ∈ {debug, per-index}`, concurrency 1..8.
- **The provider keeps it disabled unless signed:**
  - history is `null` without config (`provider.mjs:64`, `:481`);
  - it requires v3 and own-node transport (`:65`, `:482`);
  - the validated policy is included in the binding digest (`:488`);
  - it refuses without enrolled, role-committed state (`:586-587`).
- **The writer:** a private config carrying `history` is refused (`derived-writer-authority.mjs:513`, `:518-521`), and the history capability is attached only if the runtime offers `leaseHistory` (`:533-534`).
- **The tree has no remaining v1 builder:** a grep found only the backward-history tests (v2 plus negative cases).

## Findings (none is a correctness regression; each is actionable)
### M1. Header and per-index fan-out is unbounded per chunk/block, with a 32 MiB per-response cap
`backward-history.mjs:175` (header fetch), `:238`; `provider.mjs:629`.
- **Headers:** `fetchRange` issues **all** `chunk` (≤ 1024) `eth_getBlockByNumber` requests in parallel. This is pre-existing (r2 `fetchChunk`).
- **Per-index raw transactions:** each hit block issues `receipts.length` parallel requests. r3 multiplies this by `receiptConcurrency` (≤ 8).
- **Per-response bound:** each response is bounded only by `boundedRpc(..., { maxBytes: 32 << 20 })`. The theoretical in-flight memory from a misbehaving own node (untrusted transport) is 1024 × 32 MiB, far above the 16 GiB host floor. The r3 "bounded concurrency" claim covers receipt blocks only.
- **Fix (small):**
  - route `fetchRange` and the per-index raw fetch through `bounded()` with a fixed limit (e.g. 16);
  - give header calls a per-call cap (a header with a tx-hash list is ≪ 1 MiB; or request it without hashes via a lean method if one is available).
- **Tests:**
  - assert max in-flight `eth_getBlockByNumber` ≤ the limit with chunk 64;
  - per-index in-flight ≤ the limit.

### M2. Stragglers after a failure are not aborted (`:175`, `:238`)
- **The cause:** `Promise.all` rejects on the first failure, but the remaining requests keep running on the scan's signal, which is not aborted on failure. `bounded` uses a local controller, but `fetchRange` and per-index do not.
- **The effect:** after a failed chunk, up to `chunk − 1` header requests continue for up to 60 s. They mutate nothing, so this is wasted load on the own node, not a correctness issue. The provider's 60 s retry can overlap them.
- **Fix:** a local `AbortController` per `fetchRange`/per-index batch, aborted on the first rejection (the same pattern as `bounded`).

### L1. Statistics in the RAM progress count failed attempts (`:202-203`, `:172`)
- **The cause:** `stats.cacheHits`/`cacheRejected` are incremented **before** the chunk's receipts verify. Because `stats` lives in `p` and persists across retries, a chunk retried after a receipt failure is counted again.
- **Impact:** it does not affect authority. It could affect any test asserting exact `cacheHits` after a resume (per the repair log, not verified by me, its resume test asserts header and receipt refetches rather than `cacheHits`; confirm in root's run). It also makes `status().history.stats` misleading.
- **Fix:** count into locals and add them at the commit point (`:216`).

### L2. Minor
- **Docstring:** `scanBackwardLeaseHistory` says a preflight failure is "permanent" (`:151`), but the provider retries it every 60 s (`provider.mjs:252`). Align the wording.
- **Reader start:** `fileHeaderCache` is constructed at reader creation (`provider.mjs:631`) and throws if `history-cache` is not private, failing the whole reader start for history-enabled bindings. Consider reporting history `failed` instead. Fail-closed either way.
- **Untyped errors:** on the fetched path, a hostile `number` makes `BigInt(...)` throw an untyped `SyntaxError` in `verifyRange` (`:187`), so it is not a coded `malformed`. Pre-existing; it fails closed.
- **Temp files:** a second process opening the same cache directory removes in-flight temp files of the first (`:94`). The first's `put` then fails and is swallowed (`:207`). Harmless.

## Coordination for Claude50 (integrated r2 → r3 merge)
No source blocker was found for applying the r3 patch.
- **The merge checklist in the repair log stands:** five paths, `--full-index`; v2 policy fixtures; old `headers-<lo>.json` files ignored.
- **M1 and M2 are small, local edits** to `backward-history.mjs` (no API change). If taken, add them before the integrated freeze, with the two tests above.

## Verdict
**Conditional.** The source implements F1-F6 and the 1571 fix without a regression that I could find in the paths read. That is **conditional on root's actual combined run** (backward-history 13, writer-history 9, and the stated totals) and on the still-unmeasured mainnet cost and own-node method support. M1 is the only item I would fix before relying on it on the NUC host with the 16 GiB floor. **Not claimed ready.**
