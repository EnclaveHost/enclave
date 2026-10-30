# Review 1569: writer-cold-recovery-stage/r2 (authenticated backward lease history). Independent, SOURCE ONLY

**Scope and method:**
- **Not done:** no tests, builds, `node`, network, live actions or stage mutations.
- **Inputs:**
  - the stage, `SHA256SUMS` sha256 **`73fae0c1046083bfbea8014e27efc33aa1b7788f664191962e20c3b59cc22f50`** (`sha256sum -c` OK; patch `0e8c4cfd…`, job `ba12cf6f…`, PROVENANCE `8e742c06…`);
  - the author's report `logs/claude-writer-backward-history-r2.md`.
- **Code read:** the applied tree in the author's scratch `/tmp/w4` (HEAD r3 `5f141c3f` plus the staged patch; worktree = index). Its files match PROVENANCE exactly:

  | file | sha256 |
  |---|---|
  | `backward-history.mjs` | `96be88c4…` |
  | `provider.mjs` | `76a72d05…` |
  | `coverage-store.mjs` | `ca9900f5…` |
  | `lifecycle.mjs` | `798f897b…` |
  | `relay/derived-writer-authority.mjs` | `3b040fb1…` |
  | `test/derived-reader/backward-history.test.mjs` | `9aa8090e…` |
  | `test/derived-writer-history.test.mjs` | `1d97d3c1…` |

- **Unchanged trusted primitives read:**

  | file | sha256 | functions |
  |---|---|---|
  | `network/op-receipts-root.mjs` | `36c34dad228224a56bf559a6fe6ff6ee65c40738a54a18076b4abd2b1e26afe3` | `verifyBlockReceipts` 139-212, `bloomAdd` 89 |
  | `network/derived-reader/vendor/anchor-bootstrap.mjs` | `90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8` | `headerHash` 88, `authenticateAncestors` 119 |
  | `network/derived-reader/coverage.mjs` | `d6a9cd105c9421aca907c29cbebd9bc34a180bd23d855701cbf376d14b771589` | `LEASE_TOPICS` 9 |

- **Line numbers** below are in that tree, e.g. `bh:109` = `network/derived-reader/backward-history.mjs` line 109; `prov` = provider, `wa` = writer authority.
- **Bloom fill:** measured from the 52 real headers in `test/fixtures/base-headers-52965055-52965106.json` (data only).

## Verdict
**The integrity of the scan is sound for what it serves.** I found no path that serves a forged, omitted or mis-bound lease log under the stated trust (ASR-finalized N).

**It is not deployable as is.** Two High availability defects (F1, F2) mean that, once enabled, **every** writer fact after **every** restart is `history_unavailable` for an unmeasured and likely long time. That includes claims well inside runtime coverage, which r3 served today. Fix F1 before any enabling. F2–F5 decide feasibility.

## Verified correct (no action)
- **Header authentication down to the floor inclusive** (`bh:107-131`):
  - each header is recomputed with the pinned `headerHash(…, {requireIsthmus:true})`;
  - the claimed `hash` must equal the recomputed one (`hash_claim`), and `number` must equal its position;
  - the hash must equal the child's `parentHash` (or N's authenticated hash at the top);
  - the roots and the 256-byte bloom must be well-formed;
  - the loop `hi ≥ floor`, `lo = max(floor, …)` and the final `expectNumber === floor − 1` (`bh:131`) give exact coverage of [floor, N].

  This is equivalent to, and stricter than, the vendored `authenticateAncestors` (which does not require Isthmus). A small duplication; reuse is optional.
- **Bloom skip** (`bh:44-51`): the bit selection is byte-identical to `bloomAdd` (`op-receipts-root:89-91`). A block is skipped only if the authenticated `logsBloom` excludes **all** ledgers or **all three** `LEASE_TOPICS`. Blooms have no false negatives.
  - **The bloom's correctness itself** rests on the same ASR/fault-proof finality as N: an invalid bloom would be an invalid block under the proven output root.
  - **For fetched blocks**, `verifyBlockReceipts` additionally requires the OR of the receipt blooms to equal the header bloom (`op-receipts-root:200-202`).
- **Complete receipts trie and raw transaction binding** (`bh:134-150` with `op-receipts-root:139-212`):
  - `orderedTrieRoot(raw txs) == transactionsRoot` binds the count and order of transactions, so a short or reordered `per-index` list fails;
  - `txHashes[i] = keccak(raw_i)` must equal `receipt[i].transactionHash` and every log's `transactionHash`, and `txHashes.length == receipts.length`;
  - `receiptsRoot` is recomputed over the consensus encoding, including the deposit `depositNonce`/version, the Regolith→Canyon strip, and type 0x7e (0x79 refused);
  - `logIndex` is recomputed per block, `transactionIndex` must equal its position, `removed` is refused, the gas total equals `header.gasUsed`, and per-receipt blooms are checked.
  - **Base deposit receipts are covered by the primitive.** Receipts and raw transactions in tests are synthetic, an acknowledged limitation; no real deposit-receipt vector exercises the path.
- **Exact N+1 join** (`prov:396`): the scan's anchor equals the seed N's `{number, hash}`, `coverage.verifiedFromBlock === N+1`, and `verifiedAgreedRoot === N.outputRoot`.
  - `verified[]` is per-process and in memory (`coverage-store:66`). Its first entry's `agreedRoot` is `agreed.base.outputRoot` of the staged segment, which must start at `agreed+1` (`coverage-store:117-128`).
  - There is no in-process eviction ("no automatic eviction", `:123-131`), and the provider takes the seed once per process (`prov:243-246`). The join therefore cannot silently shift.
  - Scan logs are taken from [floor, N] and the coverage from [N+1, anchor]: no overlap and no gap.
- **Provisional versus finalized** (`prov:378-410`): S is served only when the requested anchor equals the current provisional segment anchor, with the overlay and a re-check that S is unchanged afterwards. The finalized path re-reads `currentAnchor`. The writer's two-anchor rules (claim ≤ B_f, 120 s, A2) are unchanged after `historyLogs` (`wa:325-326`).
- **Gating:** policy only (binding digest changes); v3 plus own-node transport; enrolled, role-committed state only (`prov` `startDerivedReader`); the writer refuses `history` in an unsigned config and closes a non-enrolled service offering it.
  - **Admin controls and the deny-only verifier are untouched.**
  - **No positive-authority index:** nothing persisted is authority. The cache is untrusted headers only.

## Findings
### F1 (HIGH, availability; easy fix): enabling history removes r3's coverage path for **every** claim after **every** restart
- **The cause:** `historyLogs` is taken whenever `availableFrom > fromBlock` (`wa:244`), which is always true after a restart because coverage starts at N+1 > the ledger floor. Its errors map to `history_unavailable` (`wa:282, 292, 325, 337`).
- **The effect:** a claim made **after** N, fully inside runtime coverage and served by r3's `from = max(fromBlock, availableFrom)` replay, is refused until the backward scan completes. If the scan can never complete (F2/F5, a node without `debug_*`, `maxLogs` or byte bounds), it is refused **permanently**.
- **Tests:** `derived-writer-history.test.mjs:106` asserts this refusal and does not cover an in-coverage claim with an unavailable history.
- **The fix:** run the unchanged r3 coverage path first. Call `readLeaseHistory` only when that replay finds no `Claimed` inside coverage (the `claim_not_covered` / "predates coverage" case).
  - **Why this is sound:** r3's replay needs only the last `Claimed` and everything after it, which coverage contains completely.
  - **Tests to add:** an in-coverage claim served while the history is `scanning`, `failed` or not joined.

### F2 (HIGH, availability/feasibility): the bloom skip barely prunes on Base, and all receipt work is sequential and redone from scratch
- **Measured on the 52 real Base headers:** bloom fill is 0.505 / **0.640** / 0.790 (min / median / max). So P(the address passes) ≈ fill³ ≈ 0.13 / 0.26 / 0.49, and P(a block needs receipts and raw transactions) for **one** ledger ≈ **4% / 16% / 43%**. With up to 4 signed ledgers it is higher.
- **The workload:** [52,515,705, N] is already ≥ 450k blocks (the fixture head is 52,965,106) and grows about 43k/day. That means on the order of **70k+ full-block `eth_getBlockReceipts` plus raw-transaction fetches** per scan, each followed by a full JS receipts-trie and transaction-trie recomputation of a few-hundred-transaction Base block.
- **No concurrency:** they run strictly one at a time (`bh:125`, `await` per block). The header phase is 256 parallel requests per chunk.
- **No progress is kept:** the scan state is RAM-only, a failure restarts the whole walk from N (`prov:248`), and every process restart starts over.
- **Cost:** plausibly hours to days per restart. Combined with F1, writer availability is gated on it.
- **The fix (no new authority):**
  - measure on the own node before activation;
  - bounded concurrency for receipt blocks;
  - an **in-process resume** on retry (keep `expectHash`/`expectNumber`/`collected` in RAM rather than restarting at N);
  - report progress in `status().history`.
- **What not to do:** persisting "verified" per-block results would be authority and is out of scope (no positive index, per the 1556 review).

### F3 (MEDIUM, availability): the restart header cache almost never hits, and churns
- **Misaligned keys:** chunk boundaries are anchored at N (`lo = max(floor, hi − chunk + 1)` with `hi = N, N − chunk, …`, `bh:109`). After a restart, N differs, so `cache.get(lo)` finds no key, or finds a chunk of the wrong length, which `verifyChunk` rejects as `truncated` and **deletes** (`bh:114`) before refetching.
- **Not tested:** the restart test reuses the **same** anchor (`backward-history.test.mjs:189-196`).
- **Cache size:** cached objects are full `eth_getBlockByNumber(…, false)` results, including transaction-hash lists. At about 10 KB+ per Base block, 450k blocks ≈ 5 GB+ against the 2 GiB `maxBytes` (`bh:55`). `put` stops silently after that, and `used()` re-`stat`s every file on every put (`bh:61`).
- **The fix:** absolute boundaries (`lo = floor + k·chunk`), storing only the RLP-hashed header fields, and eviction. Add a test with a **different** N across restarts.

### F4 (MEDIUM, availability): CPU-bound verification on the provider's event loop
- **What happens:** `verifyBlockReceipts` and `orderedTrieRoot` are synchronous JS keccak/RLP over full Base blocks, run in the reader process alongside `prepare`, the native supervision, `readDerivedLogs` and the writer's 120 s deadline path.
- **"Off the native slot (I/O only)"** in the report and in the `startHistoryScan` comment (`prov:221-232`) is not accurate for the verification half.
- **The fix:** a worker thread, or yield between blocks, plus a measured per-block cost. Treat a missed writer deadline as fail-closed, as already done.

### F5 (MEDIUM, availability): raw-transaction method not selectable, and own-node capability unverified
- **What happens:** the provider calls the scan without `rawTransactions`, so the default is `'debug'` (`bh:76`; `prov:221-242`). `debug_getRawTransactions` is often disabled or unsupported on production node RPC. There is no signed-policy field to choose `per-index`.
- **The effect:** a missing method fails the whole scan permanently, retried every 60 s, which together with F1 blocks every fact.
- **The fix:** add the method to the signed policy (or fall back to `per-index` on method-not-found), and pre-flight-check it at start-up.

### F6 (LOW, robustness of the check): join evidence is only loosely checked by the writer
- **What is checked:** `checkLeaseHistory` accepts any `join` with `c.fromBlock − 1 ≤ j.number ≤ anchor` (`wa:185`). It does not require logs in block `j.number` to carry `j.hash`.
- **Why it is low:** the reader is the enrolled runtime and the provider enforces the exact join.
- **Cheap hardening:** require `blockHash === join.hash` for logs at `join.number`, and `join.number ≥ c.fromBlock`.

### F7 (LOW, forward compatibility)
- **What happens:** `headerHash(requireIsthmus)` hashes the known field set. A future Base hard fork that adds a header field would make every post-fork header `unlinked`/`malformed`, so the scan would fail closed for all blocks.
- **The fix:** document it as a release-gated pin, the same as for the existing ASR bootstrap.

## Not exploitable (checked)
- **A forged, hidden or reordered lease log:** it needs a header-chain, receipts-root or transactions-root break.
- **A lying `logIndex` / `txHash`:** recomputed or bound.
- **A truncated receipt or raw-transaction list:** caught by the roots and the count.
- **A tampered cache:** re-hashed and re-linked from N.
- **A join shift through rotation:** there is no eviction and the seed is fixed per process.
- **Deposit field forgery:** inside the receipts trie.
- **An unsigned enablement:** refused by the reader and the writer.

## Required before any activation (in order)
1. Fix F1.
2. Measure the scan on the own node (header phase, receipt phase, total) and fix F2's sequential and restart-from-scratch behaviour plus F4.
3. Fix F3 and F5.
4. Use a real Base receipts and deposit vector, recorded and pinned, in place of the synthetic receipts.
5. Get KVM review of the `network/derived-reader/*` changes via root.
