# writer-cold-recovery-stage/r2: authenticated BACKWARD header + receipt scan. FINAL: source frozen, NOT run, NOT production-ready

**Status:** the source and its fixture tests are frozen. Nothing was run, and none of this makes it production-ready.
- **Stage:** `writer-cold-recovery-stage/r2/`, `SHA256SUMS` sha256 **`73fae0c1046083bfbea8014e27efc33aa1b7788f664191962e20c3b59cc22f50`**.
- **Patch:** `patches/writer-cold-recovery-r2-vs-two-anchor-r3.patch` (`0e8c4cfd…`) on the frozen two-anchor r3 tree `5f141c3f` gives **`e903c224163a47186b96e7f94e5094c5a043c3b2`**.
  - Re-applying the full chain r9 → r1 → r2 → r3 → this patch to a fresh archive reproduces every tree.
- **Other contents:** `jobs/root-writer-cold-recovery-r2.sh` (slice | check), `PROVENANCE.md` (hashes and counts), and the two reviews as inputs.
- **Expected `slice` total: 174** (backward-history 10, writer-history 6, plus r3's 158 unchanged).
- **Not done by me:** tests, builds, `node`, network, VM, live actions or commits. I ran only `bash -n` on the job, sha256 sums and scratch git trees.
- **Untouched:** r1–r3, r9, KVM r3, the other chats and the main checkout.
- **The driver is not duplicated.**
- **The abandoned r1 design** (committed index + H1) is preserved only as unqualified evidence: `writer-cold-recovery-stage/r1/patches/ABANDONED-unqualified-partial-vs-r2.patch` (`c54c5211…`), with its `PARTIAL` note.

## What is implemented (source)
### `network/derived-reader/backward-history.mjs` (new; KVM area)
**`scanBackwardLeaseHistory`.** From the ASR-authenticated bootstrap anchor N (its hash is the one `authenticateAnchor` bound to the ASR output root, i.e. the existing `authenticateBootstrap` seed):
- **The walk:** every header **down to the ledger floor inclusive** (policy `floor`, e.g. 52,515,705).
  - **Hash:** recomputed by the pinned `anchor-bootstrap.mjs headerHash`, with Isthmus fields required.
  - **Link:** each header must equal its child's `parentHash`, with the number checked.
  - **Refusals:** a header whose `hash` field disagrees with its recomputed hash is refused (`hash_claim`); a gap, a non-canonical header or a truncated chunk is refused.
- **Bloom skip:** a block is skipped **only** when its authenticated `logsBloom` excludes every signed ledger address **or** excludes all three lease topic0s.
- **Every other block:**
  - **receipts:** `eth_getBlockReceipts`, then the audited `op-receipts-root.mjs verifyBlockReceipts`. That covers the complete ordered receipts trie against `receiptsRoot`; OP/Base typed and deposit receipts per pinned base v1.5.1 (0x7e `depositNonce`/version, the Regolith–Canyon quirk, 0x79 refused); log positions recomputed (an RPC `logIndex` is only accepted when equal); blooms and the gas total recomputed;
  - **transaction hashes:** **bound** by recomputing `transactionsRoot` from the block's **raw** transactions (`debug_getRawTransactions`, or per-index), with `keccak(raw)` passed as `txHashes`. A receipt alone never binds a hash.
- **Returns:** every lease-topic log of the ledgers in [floor, N], in (block, logIndex) order. All events are preserved, with no compaction and nothing omitted.
- **Bounds:** `maxScanBlocks`, `maxLogs`, the chunk size and an abort signal. Memory holds one header chunk plus the collected lease logs.
- **Fail closed** on outages, missing or malformed input, root mismatches, unsupported types and bounds.

**`fileHeaderCache`:** an **untrusted** private header-chunk cache kept beside `runs/` across restarts.
- Every chunk read from it is re-hashed and re-linked from N; a tampered chunk is dropped and fetched again.
- **No persisted log is ever authority.**

**`backwardHistoryPolicy`:** the exact signed policy, in the reader binding only when configured, so it is **disabled by default**.

### `provider.mjs`
- **Policy gates:** `history` requires the v3 reader and an own-node transport. `startDerivedReader` refuses it on any self-initialized or uncommitted state, as S1 does.
- **The scan:** it starts **in the background** when the ASR seed is accepted, off the native slot (I/O only), over `boundedRpc(baseUrl, 32 MiB, 60 s)` (untrusted transport). A failed scan is retried after 60 s on a later `prepare`, never used partially.
- **`readLeaseHistory({address, deployment, anchor})`:** it returns the deployment's lease logs over [floor, anchor] = scan [floor, N] ∪ runtime coverage (N, anchor], with the provisional overlay for S. It is served **only** if:
  - the scan completed for **this** seed;
  - the coverage starts at **exactly N+1**, derived from **N's output root** (`coverage-store status().verifiedAgreedRoot`, new);
  - the anchor is current;
  - the response is within its byte bound.
- **Writes nothing:** no journal, floor or replica. **The authority floor is never advanced or rolled back** by the scan.
- **`status().history`** reports the state, anchor, error and scan stats.

### `lifecycle.mjs`
Exposes `leaseHistory` only when the signed config carries the policy.

### `relay/derived-writer-authority.mjs`
- **When it is used:** when the probe shows runtime coverage starting after the writer's ledger floor and the runtime offers `leaseHistory`.
- **The check:** `checkLeaseHistory` strictly validates the answer:
  - the format, the anchor, the lease echo and the join point;
  - **range from ≤ the ledger floor to the anchor**;
  - every log through the same ABI-shape, range, order and anchor-hash rules as `checkDerivedLogs` (factored into `pushLeaseLog`, with no semantic change).
- **Unchanged:** `replayToRow`, the 120 s ceiling on S, claim ≤ B_f with B_f replay agreement, the deny-only verifier, A2 evidence before the fact, the role enrollment and admin controls.
- **Unavailability** (running, failed, not joined, not enabled) gives `history_unavailable` (retryable). The default path is unchanged when the capability is absent.
- **The selector:** the history is taken only from the enrolled state's runtime. An unsigned config or service offering it is refused (and closed).

## Tests (written, not run): 16 new
**`test/derived-reader/backward-history.test.mjs` (10):**
- **Real Base mainnet headers** (52 parent-linked, 52,965,055–52,965,106):
  - each recomputes its hash, and the whole range authenticates down to the floor inclusive;
  - a real-bloom-excluded ledger fetches no receipts;
  - where a real bloom may match, receipts are demanded;
  - an altered header gives `unlinked`, a wrong-number header `discontinuity`, and a wrong anchor `unlinked`.
- **The bloom rule:** skip only on exclusion.
- **A complete synthetic canonical history:**
  - the first claim is **in the floor block**;
  - noise (a Funded event, a foreign address) is excluded;
  - a release followed by a same-runner re-claim is preserved;
  - exact positions and transaction hashes; receipts fetched only for bloom hits; per-index raw transactions are equivalent.
- **Tampering and failures:**
  - a wrong receipts root;
  - missing or reordered receipts;
  - a forged `logIndex` or transaction hash;
  - altered raw transactions;
  - a header root change (`unlinked`, or `hash_claim` when the hash field is stale).
- **Typed and deposit receipts** (0x0/0x1/0x2/0x4/0x7e), with refusals for a missing deposit version, type 0x79 and deposit fields on a non-deposit.
- **Outages, truncation and bounds;** abort.
- **Restart cache:** reused but re-authenticated; a tampered chunk (a hidden release bloom) is rejected and refetched with the same history; a tampered cache plus a lying node is refused.
- **Provider:**
  - the old claim is served **only** after scan completion **and** the exact N+1 join;
  - the strict check plus the unchanged replay finds the pre-bootstrap claim;
  - a ledger floor below the scan floor, a foreign ledger or a stale anchor are refused;
  - nothing is persisted.
- **Provider outage:** fails closed, then the scan is retried.
- **Policy:** exact keys, the binding changes only when configured, refused on unsigned state.

**`test/derived-writer-history.test.mjs` (6):**
- an old claim is served with exact fact bytes and `historyJoin` evidence;
- release/re-claim and release refusal in the history;
- the default path is unchanged;
- strict answer checks;
- unavailability gives `history_unavailable`;
- the two-anchor case: claim ≤ B_f, A2 evidence, a late claim gives `claim_not_final`;
- the selector (enrolled branch only; unsigned refused).

**Not real:**
- **receipts and raw transactions:** synthetic but canonical (the same pinned encoders). No real Base receipt vector was available offline;
- **the native echo** fixture;
- **performance:** none of this is a performance claim.

## UNRESOLVED (activation requirements; nothing enabled)
1. **Unmeasured feasibility:**
   - the scan's own-node cost: N − 52,515,705 headers (N is days behind head) plus the bloom-hit receipts;
   - whether the **own node** serves `eth_getBlockReceipts` and `debug_getRawTransactions` (or per-index raw transactions) within the transport caps;
   - the latency to first `complete` after each restart. Writer facts for old claims are `history_unavailable` until then.
2. **KVM review** of the changed `network/derived-reader/*` (provider, coverage-store, lifecycle) and the new `backward-history.mjs`, via root.
3. **The driver** (separate agent) and its interaction with the scan: the scan is I/O, not the native slot.
4. **Enabling** needs a measured reader template carrying `history` (the 52,515,705 floor and the ledger list), the signed binding rotation, and root/KVM approval. **Unchanged from before:** M1–M5 and the possibility that S cannot meet 120 s.
5. **Earlier items still open:**
   - A2 capacity (r2 §B);
   - audit retention after a clear;
   - the §7 a/b policy decisions;
   - never-enrolled restored-group admin recovery.
