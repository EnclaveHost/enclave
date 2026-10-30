# writer-cold-recovery-stage/r5: retained-bytes bound (root 1606 code review). EARLY minimal contract; nothing run

**Base:** frozen history r4 (`9fa22972…`, tree `571b5c84`; root 1606: 183 fixtures PASS). r5 is one patch against r4. r1–r4 are untouched.
- **Scratch:** a new unique `/tmp/claude-hist-r5-1609`, made from `git archive 571b5c84`.

**INCIDENT (disclosed):**
- **What happened:** my first scratch command used `/tmp/w8`, which was the r4 author's existing scratch. My `set -e; test ! -e` guard did not stop the command, so I copied `/tmp/w6` into it as `/tmp/w8/w6` and ran `git add -A -f` there (changing its index). A `git apply --index` failed atomically, so no working files changed.
- **Restored at once:** I removed the stray index entry with `git update-index --force-remove w6`, and the index tree is again exactly `571b5c84`. I deleted only `/tmp/w8/w6`, after confirming it was my copy (ctime 12:53:14, the same HEAD as `/tmp/w6`).
- **Left behind:** nothing else changed apart from the rewritten index file (same content tree) and harmless new git tree objects. Neither 50's scratch nor any stage was touched.

## The bug (root 1606)
- **Why the r4 budget does not bound retention:** `limitRpc` releases a call's charge when its response resolves, so it bounds **in-flight** bytes only.
- **Headers:** `fetchRange`/`allOrAbort` keep every **full** header response (up to 4 MiB each, including transaction-hash lists) until the whole chunk settles. With `chunk` ≤ 1024 that is up to 4 GiB of response bytes. `leanHeader` runs only later, in `verifyRange`.
- **Raw transactions:** per-index raw transactions are likewise kept (1 MiB each) until the whole block settles, not bounded by the 32 MiB whole-block cap.

## Minimal r5 contract
1. **Headers are reduced at arrival.** Each `eth_getBlockByNumber` result is reduced **inside its own call's continuation**, before anything else holds it.
   - **Checks first:** the r4 per-header checks run on the full object: missing → `missing`; `headerHash(…, requireIsthmus)` → `malformed`; a claimed `hash` ≠ the recomputed one → `hash_claim`; `number` ≠ position → `discontinuity`.
   - **Then reduced:** it becomes the lean hashed fields, plus the claimed hash when present, now proven equal.
   - **Then charged:** the retained JSON size is checked against `MAX_RETAINED_HEADER_BYTES` (8 KiB per header) and a per-chunk aggregate (`RETAIN_LIMITS.chunkHeaderBytes` = 8 MiB; 1024 × 8 KiB).
   - **Unchanged:** `verifyRange` still re-runs every check, including the parent links from N, and the cache format is unchanged.
2. **Per-index raw transactions are charged at arrival.** Each is checked as a raw hex string (`missing` otherwise), and its length is charged to a per-block aggregate (`RETAIN_LIMITS.blockRawHexBytes` = 32 MiB of hex text, the same as the `debug_getRawTransactions` whole-block response cap). The full `transactionsRoot` recomputation and the `keccak(raw)` transaction-hash binding are unchanged.
3. **Overflow is fail-closed and non-blocking:** `fail('resource_bound')`. The accountants never wait for a release, so there is no deadlock with workers of the same batch; r4's `allOrAbort` aborts the batch and awaits every call before rejecting. No straggler, no progress commit, and no queued call of the batch starts (r4 invariant).
4. **Fixed production caps:** code constants, not policy. The provider passes nothing. Tests use a `retainLimits` option with small values.
5. **No total-memory claim.** r4's 128 MiB is in-flight response bytes only.
   - **Retained per scan, as JSON/text bytes:** ≤ one chunk of lean headers (8 MiB), plus per receipt task (≤ `receiptConcurrency`, ≤ 8) one receipt list (≤ 32 MiB response) and one block's raw transactions (≤ 32 MiB hex text; the decoded copy is ≤ 16 MiB during verification).
   - **JS object expansion is unmeasured.**
6. **Tests to add:**
   - many header responses, each within its cap and carrying large non-hashed baggage, do not accumulate (only lean bytes are retained);
   - a lean-retention overflow aborts with zero stragglers and no commit;
   - per-index raw transactions each within 1 MiB but over the block aggregate give `resource_bound`, with zero stragglers, no later calls and no commit;
   - `hash_claim`, `discontinuity` and `root_mismatch` are still refused.

---
## FINAL: frozen, NOT run

**Stage:** `writer-cold-recovery-stage/r5/`, **SHA256SUMS sha256 `e9fa8b3773371a55fb866fd0ad87b9344ddf4d65260a79c869f6a4fb7b0f1ba0`**. Files are 0444:

| file | sha256 |
|---|---|
| `patches/writer-cold-recovery-r5-vs-r4.patch` | `7bc9a4e5db34326ddd1c49ce312e421e3e9574a6a86f7d761a9a845179b3d6b9` |
| `jobs/root-writer-cold-recovery-r5.sh` | `ae6485ed…` (r4 job + CR4 verification + PATCH7; backward-history **19**) |
| `PROVENANCE.md` | `f45b33e6…` |
| `inputs/claude-history-r4-bounds.md` | |

**Trees:** r4 `571b5c84` + the patch = **`97c8a15a30a0b8859645b5c92e1477de0bb6f602`**, reproduced from a fresh `git archive`.

**Re-verified unchanged:** r4 `9fa22972…` and r3 `320b80b8…`.

**What I ran:** `bash -n`, sha256 and git trees in my own scratch only. No tests, builds, `node`, network, USB or live actions.

**Touched:** only `network/derived-reader/backward-history.mjs` (r4 `49e834d5…` → `0977bcdb…`) and its test (`21334a25…` → `30bc227b…`). `provider.mjs`, the writer and the v2 policy are unchanged.

### The patch, exactly
- **New constants:** `MAX_RETAINED_HEADER_BYTES` = 8 KiB and `RETAIN_LIMITS` = `{chunkHeaderBytes: 1024 × 8 KiB, blockRawHexBytes: 32 MiB}`. A `retention(cap)` accountant only adds and throws `resource_bound`; it never waits.
- **`fetchRange`:** each `eth_getBlockByNumber` promise is `.then(retainHeader)`.
  - **On the FULL reply:** `missing` / `malformed` (`headerHash` with Isthmus required) / `hash_claim` / `discontinuity`.
  - **Then:** the lean hashed fields (plus the claimed hash, which is now proven equal to the recomputed one); a per-header size check; the chunk aggregate charge.
  - **Unchanged:** `verifyRange` still re-checks everything and the parent links from N. The cache content is unchanged (still lean, no hash).
- **Per-index raw transactions:** each reply is `.then`-checked (a raw hex string) and charged by its hex length to the block aggregate. `transactionsRoot` over all raw transactions and the `keccak(raw)` transaction-hash binding are unchanged. The `debug_` path is already one reply ≤ 32 MiB.
- **An overflow throws inside the call's continuation.** r4's `allOrAbort` aborts the batch and awaits every call. `bounded()` aborts the other receipt tasks and awaits them. limitRpc drops queued calls of the aborted batch, and progress and statistics commit only at the chunk end.
- **`retainLimits` is a scan option for tests only**, validated to be no larger than the production constants. The provider passes nothing, so the production caps are fixed.

### Tests (3 new; backward-history 19; slice 186; prepared, NOT run)
1. **Fixed caps and lean-only retention:**
   - the production caps are the stated constants;
   - **64 header replies, each carrying about 14 KB of non-hashed baggage** (well under the 4 MiB per-reply cap), pass under a 160 KiB chunk budget that their total (about 1 MB) exceeds, so the baggage is not retained;
   - the lean bytes themselves under a 20 KiB budget: `resource_bound`, nothing in flight at the rejection, nothing started after it, no commit, and the queued calls never started;
   - out-of-range limits give `bad_input`.
2. **Per-header cap:** one header with 8 KiB of hashed `extraData` gives `resource_bound` at arrival, with in-flight siblings aborted and settled and the queued calls never started. `hash_claim` and `discontinuity` are still refused on the full reply.
3. **Per-index aggregate:** each raw transaction is within its cap, but a block over the aggregate gives `resource_bound` with no stragglers or commit. A block exactly at the cap passes with the complete ordered history. A receipt list that omits transactions still gives `root_mismatch` (completeness = the transactions root).

**Root:**
```
bash jobs/q-exit-status.sh wcr-r5-slice 512 unshare -Urnm bash writer-cold-recovery-stage/r5/jobs/root-writer-cold-recovery-r5.sh slice
```
Then `check`.

### Retained bound (honest)
Per scan, as JSON/text bytes:
- ≤ one chunk of lean headers (≤ 8 MiB);
- plus, per concurrent receipt task (≤ the signed `receiptConcurrency`), one parsed receipt list (≤ 32 MiB reply) and one block's raw transactions (≤ 32 MiB hex), with transient decoded bytes during verification;
- plus r4's in-flight replies (≤ 128 MiB).

The JS object expansion of parsed receipt lists is **unmeasured**. This is **not** a total-memory bound. Keep `receiptConcurrency` small until it is measured.

**Composition:** apply the patch onto any tree holding the r4 blobs of the two paths, e.g. the integrated stage's next composition. Do not mutate Claude50's scratch.
