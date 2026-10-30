# writer-cold-recovery-stage/r3: repair of review 1569 + root 1571 (FINAL: frozen, NOT run)

**Stage:** `writer-cold-recovery-stage/r3/`, **SHA256SUMS sha256 `320b80b8cadaeaa622717da96522d64460ea1dee0d5372e793fb525088ac280e`**. Files are 0444:

| file | sha256 |
|---|---|
| `patches/writer-cold-recovery-r3-vs-r2.patch` | `dbe2d1a65769af8aaf051c55dedc095087bfa73ebd4c751fa6c3f36435413f1d` |
| `jobs/root-writer-cold-recovery-r3.sh` | `636fbc3b…` |
| `PROVENANCE.md` | `7874f8cf…` |
| `inputs/claude-backward-history-review-1569.md` | |
| `inputs/root-history-failure-1571.md` | |

**Trees:**
- frozen r2 (`73fae0c1…`, unchanged, re-verified) has tree `e903c224`;
- r2 + the patch gives **tree `a4dd62c303e2742dadc2b5fdf9d6d0023e5cd91a`**, reproduced from a fresh `git archive e903c224` in `/tmp/w6-verify`.

**What I ran:** no tests, builds, network, USB, live or VM actions.
- I edited only in the private scratch `/tmp/w6`. `/tmp/w4` and `/tmp/w5` (Claude50's integrated stage) were not touched.
- **Executed:** `bash -n` on the job, sha256 sums and scratch git trees.
- **One inadvertent `node --version`** (prints a version string only; output discarded). It ran nothing else.

## Changes (5 paths; hashes in PROVENANCE)
| finding | r3 change |
|---|---|
| **root 1571** | The cache default bound is `DEFAULT_CACHE_MAX_BYTES = 2 * 1024 ** 3` (2,147,483,648). The bound is validated as 1 MiB..64 GiB, so `2 << 30` is refused. |
| **untrusted cache** | `get` opens with `O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK` and requires `fstat` regular, this uid and ≤ 4 MiB. It reads only through that fd (a growth check is included) and returns only an array of exactly `chunk` entries; anything else gives `null`. The listing uses `lstat` regular files matching `headers-<chunk>-<lo>.json` only; nothing is followed. `put` writes an `O_EXCL\|O_NOFOLLOW` temp file plus `rename`. Leftover temp files are removed at open. |
| **F3** | **Absolute chunks** `lo = floor + k·chunk`, independent of N. Only **complete** chunks are cached. A complete cached chunk containing a smaller N is **sliced** to [lo, N], so headers above N are never used. **Lean** cache entries keep only the RLP-hashed fields (`HASHED_HEADER_FIELDS` = anchor-bootstrap BASE + `ISTHMUS_FIELDS`), with no transaction lists or `hash`. **Bounded eviction** (oldest written first) to ≤ `maxBytes` and ≤ `maxFiles` (65,536). |
| **F5** | **Signed policy v2** (`enclave-lease16-backward-history-policy/v2`; v1 is refused) adds the required keys `rawTransactions: 'debug'\|'per-index'` and `receiptConcurrency: 1..8`. The provider passes `preflight: true`: before any header fetch, the node must serve `eth_getBlockReceipts(N)` (non-empty) and the signed raw method at N. A failure is the typed code `preflight`, retried by the existing 60 s rule. There is no silent fallback (`boundedRpc` drops JSON-RPC error codes, so a method-not-found fallback could not be strict). |
| **F2** | **Bounded receipt concurrency** per chunk (signed, ≤ 8); the first failure aborts the rest. **RAM-only progress** per authenticated seed: `{key: [N, N.hash, floor, ledgers, chunk], nextHi, expectHash, collected, stats}`. It advances **only after a chunk's headers and all its receipts are verified**. The provider reuses it on a retry for the same seed, so a failed scan resumes below the last verified chunk instead of at N. A different anchor or scope resets it. Never persisted. `status().history.remainingThrough` reports it. |
| **F4** | The event loop is yielded (`setImmediate`) after each header chunk and after each block's synchronous receipts verification. **No worker isolation**: a single block's verification still blocks the loop for its (unmeasured) duration. The provider comment now says so, instead of "I/O only". |
| **F1** | Writer `leaseLogs` reads **runtime coverage first**. If coverage starts at the ledger floor or contains a `Claimed`, it is returned and the history is **never consulted**. This is the identical replay: the last `Claimed` and everything after it are inside complete coverage, and for two anchors `C > B_f` is still refused before the `B_f` replay. Only a lease with no claim inside coverage uses the history; its unavailability stays `history_unavailable`. The r2 messages and the `claim_not_covered` paths are preserved. |
| **F6** | `checkLeaseHistory`: any lease log of block `join.number` must carry `join.hash`, else `derived_logs_invalid`. |

**Unchanged (not weakened):**
- per-header `headerHash` with Isthmus required, `hash_claim`/`discontinuity`/`unlinked`, and the floor-inclusive walk with the `gap` check;
- the bloom rule;
- `transactionsRoot` from raw transactions and `keccak(raw)` binding;
- the full `verifyBlockReceipts` (receipts trie, deposits, `logIndex`, gas, blooms);
- the exact N+1 join;
- the provisional overlay;
- default-disabled signed binding plus enrolled-state gating;
- admin controls;
- no persisted authority and no positive index.

## Tests (prepared, NOT run). Root job counts: backward-history **13**, writer-history **9**, `slice` total **180**
- **Adapted:**
  - the r2 restart test: with absolute chunks only the partial top chunk `[1012]` is fetched, and there are 4 cache hits;
  - the provider `POLICY` is v2;
  - the policy refusals add a bad method, concurrency 0 and 9, the v1 format and a missing key;
  - the provider outage test now also asserts `remainingThrough = 1007` after the failure and that the retry fetches only headers ≤ 1007;
  - the writer test's call list now includes the coverage read.
- **New, reader:**
  1. **The cache:**
     - the default is exactly 2 GiB, and `2 << 30` is refused;
     - lean storage drops `transactions`/`size`/`hash`;
     - files are keyed by chunk size;
     - a symlink, a FIFO (non-blocking) and an oversized file are never read;
     - eviction holds at `maxFiles` = 2 (the oldest is gone) and at a 1 MiB byte bound (an over-bound file is refused).
  2. **A changed N:** at N = 1009, then 1012 (three complete chunks reused, headers fetched only for 1009–1012), then 1010 (a cached chunk sliced, 0 fetches).
     - A tampered entry above N is irrelevant at N = 1010.
     - A tampered cache plus a lying node gives `unlinked`.
  3. **Concurrency, resume and pre-flight:**
     - **Concurrency:** at most `limit` receipt blocks in flight (1 and 2), with the same complete history.
     - **Resume:** after a failure at 1004 the progress is at `nextHi` 1005; the retry fetches no header > 1005, refetches only the receipts of 1003 and 1000, and returns the same history. Another anchor does not inherit the progress.
     - **Pre-flight:** missing `debug_getRawTransactions` gives `preflight` with no header fetched; `per-index` passes; empty receipts at N give `preflight`.
- **New, writer:**
  1. **F1, single anchor:** an in-coverage claim (an older claim and a release exist before coverage) is served from coverage for **each** unavailable state (scan not completed, failed, not joined, not enabled) and with no history capability. Each case has no history call and no `historyJoin`. A release after the in-coverage claim is still `inconsistent_logs`. A claim only before coverage plus an unavailable history is still `history_unavailable`.
  2. **F1, two anchors:** an in-coverage claim ≤ B_f is served from coverage with A2 evidence recorded and no history call. A later claim in (B_f, S] gives `claim_not_final`.
  3. **F6:** a join-block log with another hash gives `derived_logs_invalid`; with the join hash it is served (`historyJoin` evidence).

**Not executed by me:** none of the code or tests above, so syntax and behaviour are unverified until root's run. Root 1571's failing r2 assertion (`cacheHits > 0`) is now covered by the adapted restart test and the cache test.

## Merge instructions (Claude50 / root)
1. **Patch base:** the r3 patch is `--full-index` against r2 (`e903c224`) and touches only these five paths:
   - `network/derived-reader/backward-history.mjs`
   - `network/derived-reader/provider.mjs`
   - `relay/derived-writer-authority.mjs`
   - `test/derived-reader/backward-history.test.mjs`
   - `test/derived-writer-history.test.mjs`
2. **Applying:** if the integrated stage still has the r2 blobs there, use `git apply --index`; otherwise use `git apply --3way` and resolve.
3. **Driver code is not touched.**
4. **Any template or fixture** building the history policy must move to **v2** with `rawTransactions` and `receiptConcurrency`.
5. **Old cache files** `headers-<lo>.json` are ignored and should be deleted by the operator.
6. **The `history-cache` path** is unchanged: beside `runs/`.

## Remaining feasibility limitations (honest; root owns the node performance gate)
- **Unmeasured:**
  - the scan cost from N down to 52,515,705;
  - the bloom pass rate on Base (about 16% per ledger at the median fill of the 52 real headers);
  - the receipt and raw-transaction transfer;
  - the per-block JS verification time;
  - the effect of concurrency 1..8 on the own node and on the event loop;
  - whether the own node serves `debug_getRawTransactions` or per-index raw transactions (the pre-flight now fails fast and typed).
- **Every restart still rescans every receipt block.** Only headers are cached; receipt results cannot be cached without becoming authority. F1 removes the dependency of in-coverage claims on the scan, but old claims stay `history_unavailable` until each start's scan completes.
- **No worker isolation (F4):** each block's verification remains synchronous on the reader's loop.
- **F7 (a future header field)** still fails closed, as a release-gated pin.
- **Receipts and raw transactions are synthetic** in tests. A real Base receipts and deposit vector is still needed.
- **KVM review** of the `network/derived-reader/*` changes is required via root.

The KVM router plan (`native-manager-routing-plan.txt`) was not read: no spare budget after the primary task.
