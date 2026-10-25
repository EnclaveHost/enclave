# OP (Base) receipts-root encoder/verifier for A5 complete historical logs (prepared, tested offline)

## Status

| Item | State |
|---|---|
| JS strict encoder/verifier | **Prepared and tested offline.** Not integrated into any running service. |
| Live calls / downloads / native compile / commit | **None.** |
| Native Rust cross-check | **None compiled** (§5). |

## 1. What it does (`op-receipts-root.mjs`)

**Pure ES module;** keccak and the header-hash function are injected.

**Entry point:** `verifyBlockReceipts({header, expectedBlockHash, receipts, txHashes?, chain}, {keccak, headerHash})` recomputes everything and refuses on any mismatch. The JSON `receiptsRoot` is **never** trusted.

1. **Header authentication.** `keccak(RLP(header))` must equal the **authenticated** `expectedBlockHash`, which comes from the A1/A2 anchor parent-hash chain and never from the same RPC answer. The `header.hash` field must agree too.
2. **Each receipt, in order:**
   - **Type:** one of `0x0`, `0x1`, `0x2`, `0x4` or `0x7e` (Base). `0x3`, `0x79` (EIP-8130; Base mainnet `everest: None`), unknown types and pre-Byzantium `root` receipts are **refused**.
   - **Block binding:** `blockHash`/`blockNumber` equal the header's; `transactionIndex == i`; logs carry the same block/tx; `logIndex` runs contiguously from 0 across the block; `removed: true` is refused.
   - **Field strictness:** canonical quantities (no leading zeros, ≤ uint64), exact byte lengths, ≤ 4 topics, status 0/1, non-decreasing `cumulativeGasUsed`.
   - **Deposit rules by fork timestamp:**
     - after Regolith, `depositNonce` is required;
     - after Canyon, `depositReceiptVersion` is required and must equal 1;
     - neither field is allowed before its fork, and neither is allowed on non-deposits.
   - **Bloom:** recomputed from the logs; the RPC `logsBloom` must match it.
3. **Whole block:**
   - last `cumulativeGasUsed == header.gasUsed`;
   - the OR of the receipt blooms equals `header.logsBloom`. This check is weak by itself, because Base blooms are dense; the root is decisive.
   - The ordered trie root of the EIP-2718 encodings must equal `header.receiptsRoot`. Under the Regolith ≤ t < Canyon rule, `depositNonce` is stripped (base `crates/execution/consensus/src/proof.rs:13-42`).
4. **Transaction binding (`txHashes`).** It binds receipt *i* to transaction *i*. The hashes **must** come from a body whose `transactionsRoot` the caller verified.
   - Without them, receipt and log **content** is still root-verified, but `txHashBinding` is `"unauthenticated …"`, **and the result cannot be exported** (§2).
5. **Output hardening (review fix).**
   - The result is **deep-frozen** and **branded** in a module-private `WeakSet`.
   - Exported JS numbers (block number, timestamp, logIndex) are **refused above `Number.MAX_SAFE_INTEGER`** (`unsafe_integer`), never rounded. Gas stays BigInt internally.
6. **Resource bounds (review fix).** `maxReceipts` (default 50,000) and `maxLogs` (default 500,000) per block are checked before any per-receipt work (`resource_bound`).
   - **Transport bounds are the CALLER's job,** before JSON parsing: a streamed response byte cap, a timeout and `redirect: "error"`, as in `l1-anchor-a1/a1-read.mjs` `rpc()`.
   - The module is pure and never fetches.

**Pinned rules** (base v1.5.1, git `5476069f`):

| Rule | Value | Source |
|---|---|---|
| Base mainnet Regolith | 1686789347 | `crates/common/chains/src/config.rs:465` |
| Base mainnet Canyon | 1704992401 | `config.rs:466` |
| Everest | `None` | `config.rs:479` |
| Receipt types | listed above | `receipts/receipt.rs:26-45` |
| Deposit field order | as above | `receipts/deposit.rs:112-130` |

**Our ledger range** (≥ 52,515,705) is post-Canyon.

## 2. Integration contract (complete-logs, A5)

1. Authenticate the headers N_lo..N with `anchor-bootstrap.mjs` `authenticateAncestors` (recomputed hashes, linked to anchor N).
2. Run `complete-logs.mjs` `planCompleteScan` (headers with **recomputed** hashes) to get the bloom candidates.
3. For **every** candidate, fetch `eth_getBlockReceipts` from our untrusted EL, then call `verifyBlockReceipts` with `expectedBlockHash` = that candidate's authenticated hash.
4. Pass `completeLogsEntry(result)` to `assembleCompleteLogs`. A missing candidate gives `incomplete`, never an empty history.

**Export rule (review fix).** `completeLogsEntry` **refuses**; it never strips:
- anything that is not a branded `verifyBlockReceipts` result from this module instance (`not_verified`: hand-built, spread or JSON-copied objects);
- any result verified **without** a transactionsRoot-verified body (`tx_unbound`).

So exported logs never carry an unproven `transactionHash`. The caller **must** supply `txHashes` from a body it verified against the authenticated header's `transactionsRoot`.

**Brand scope:** a trusted-internal API guard against accidental or hand-built objects within one loaded module instance. It is **not** a security boundary against hostile code in the same process, and another copy of the module has its own brand set. There is deliberately no content-only export.

**Binding note.** These rules are fixed to the pinned base v1.5.1 receipt and fork set. A new client binary or fork (for example Everest/0x79, or new deposit fields) changes the encoding contract. Revalidate the rules, the vectors and this module before reuse; don't assume binary compatibility.

## 3. Tests

Shared queue at 256 MiB inside `unshare -rn`, with **no network**. Logs are in `logs/`.

**`run-tests.sh` → `logs/tests.*`: 35/35 pass, 0 skipped** after the review fixes.
- **Before the review:** 31/31, kept as `logs/tests.r3-prior-31pass.*`.
- **4 new regressions:**
  - **Real blocks without a body:** for all 5 real Base blocks verified **without** a body, the content root verifies but `completeLogsEntry` gives `tx_unbound`.
  - **Brand:** spread, hand-built and JSON-copied results give `not_verified`; results and logs are frozen.
  - **Safe integers:** number/timestamp of 2^53 give `unsafe_integer`, and more than uint64 gives `bad_field` (with a stub header-hash, only to reach the guard).
  - **Resource bounds:** `maxReceipts`/`maxLogs` give `resource_bound`.

**Independent known-root vectors:**
- **REAL Base mainnet.**
  - **Data:** 28 headers 52,965,266–52,965,293 and the **full receipts of 5 blocks = 1,824 receipts** (types 0x0/0x1/0x2/0x4/0x7e, deposits v1).
  - **Fixture:** `test/fixtures/base-mainnet-52965266-52965293.json.gz` (sha `921a72e6…`), captured 2026-10-23 from an untrusted RPC for the earlier `rpc-receipt-witness` work, where it was verified by **op-geth DeriveSha**.
  - **Here:** every header hash is recomputed and the parent chain checked; every root reproduces.
- **REAL Ethereum mainnet block `0x14e8d38`:** 202 receipts (Helios upstream test data `2af9b418`) reproduce its receiptsRoot.
- **UPSTREAM-ASSERTED base `proof.rs` vectors.**
  - **Coverage:** Bedrock, **Regolith (nonce stripped; the test shows the quirk changes the root)**, Canyon, and EIP-2930 with a fixed bloom.
  - **Extraction:** `extract_proofrs_vectors.py` reads them from git `5476069f` (sha `be540359…`) into `test/fixtures/base-proofrs-vectors.json`. It refuses to write a partial vector.
- **Trie boundary:** a node of exactly 32 bytes must be hashed. The expected root is built with viem's independent `toRlp`.

**End-to-end with complete-logs.** The bloom plan over the 28 real linked headers selects exactly the 5 receipt blocks; their verified entries recover the **real `Renewed` lease event** (tx `0x4664…`, logIndex `0x169`). Dropping one entry gives `incomplete`.
- **Test stand-in:** that test passes the RPC header's transaction list as `txHashes`. **That list is NOT authenticated here;** it only exercises the binding path. Production must use a transactionsRoot-verified body.

**25 named negative cases:** dropped, middle-removed or swapped receipts; status, gas and log tampering; a lying RPC bloom; deposit nonce/version missing or wrong; deposit fields on 0x2; types 0x3, 0x79 and 0x7d; a `root` field; a removed log; a logIndex gap; a non-canonical quantity; a wrong block; a tampered header; a wrong expected hash; a tx-binding mismatch; a missing list. Plus the Regolith-window rule.

**`mutants.sh` → `logs/mutants.*`.** A baseline passes, then **14/14 mutants are killed**:
- the original 10 (kept as `logs/mutants.r2-prior-10killed.*`): Regolith strip, header hash, root compare, deposit nonce, **inline 32-byte threshold**, tx order, receipt bloom, deposit version, gas total, status encoding;
- **new:** brand check, tx-unbound refusal, safe integer, resource bound.

**Kept failed attempts:**

| Log | What happened |
|---|---|
| `tests.try1-extractor-missed-log` | the extractor missed one `Default::default()` data log, so the Bedrock root mismatched. Fixed, and the extractor now asserts completeness. The same run had one test expectation that was wrong (bloom vs root code). |
| `tests.r2-before-boundary`, `mutants.r1-inline-survived` | the inline-threshold mutant survived. That gap is closed by the boundary test. |

**What is mocked and what is not:**
- **Nothing is mocked:** all roots come from real data or upstream-asserted vectors.
- **Fixture provenance:** the Base receipts came from a public RPC at capture time, but they are authenticated here only through header hashes and roots.

## 4. Not done / limits

- **No live use yet.** It needs our own Base EL, which is still downloading and disabled, plus authenticated headers from A2.
- **Transaction hashes in the tests** come from the RPC header's `transactions` list, used to exercise binding. Production must take them from a `transactionsRoot`-verified body.
- **No Rust or native cross-check was run** (§5).

## 5. Next step: an independent native cross-check (exact, not prepared, not compiled)

**Proposal:** a ~40-line Rust binary in a fresh crate depending on base v1.5.1 `base-execution-consensus` (`calculate_receipt_root_no_memo`) and `base-common-consensus` (`BaseReceipt` serde). It would read the same fixture receipts and print the roots, to compare with this module.

**Requirements:**
- its own `CARGO_HOME`/target;
- **never** the M7/M10 trees or caches;
- the shared queue at ≥ 1536 MiB, run by root.
