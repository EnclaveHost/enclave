# Native derivation result v3: lease16 coverage (protocol for KVM's reader and the relay writer adapter)

**Binary:** `derivation_harness_lease_v3 <trusted.json> <witness>`.
- Exit 0: verified; stdout is exactly one v3 JSON object.
- Exit 1: `{"format":"enclave-base-derivation-result/v3","refused":"<reason>"}`.
- Exit 2: usage.

**Unchanged from v2:**
- the trusted input is exactly the frozen combined-r1's 10 keys;
- witness handling (Local keys stripped, hash/KZG checks), `accept()` and `bind_head()`, all reused unchanged from `derivation_harness_combined.rs` faa14271, which is included by `#[path]`.

**New input constraint (a value check, not a new key):** `intermediateBlockInterval` must be 1, and `claimed − agreed` must be 1..=1800. Both are checked before any block executes.

**v2 stays frozen:** v2 consumers keep `derivation_harness_combined`. v3 is a separate binary and format.

## Output
```
v2 fields (format replaced by "enclave-base-derivation-result/v3") +
coverage: {
  format: "enclave-lease16-coverage/v1", filterId: "lease16-events/v1",
  fromBlock: agreed+1, toBlock: claimed,
  blocks: [{number, hash, stateRoot, messagePasserStorageRoot, outputRoot, receiptsRoot, transactionsRoot, timestamp}]  // every block, in order
  logs:   [{address, blockNumber, blockHash, logIndex, topics, data, txHash}]                                         // (blockNumber, logIndex) ascending
}
```
**Encoding:** hashes, addresses, topics and data are lowercase `0x` hex; numbers are JSON integers; `timestamp` is in seconds.

**Filter `lease16-events/v1`:** `topics[0] ∈` keccak256 of:
- `Claimed(bytes32,bytes32,address,uint64,uint256)` = `0xa8cc21eb…`;
- `Renewed(bytes32,bytes32,uint64,uint256)` = `0xc3f167f2…`;
- `Released(bytes32,bytes32,uint256)` = `0x0e334fd1…`.

These are the compiled EnclaveDeployments ABI events. Every emitting address is included; the consumer filters by its own confirmed ledger. Logs without topics never match.

## Where the data comes from
**Only from this run's execution.**
- **Capture point:** inside the derivation loop (a verbatim copy of upstream 5476069f `advance_to_target` and the `WitnessExecutor::run` body, plus 3 capture lines, checked mechanically by `jobs/check_upstream_copy.py` against the pinned tarball). After each SUCCESSFUL `execute_payload` and its `compute_output_root`, and before the cursor advances, the executor's own `BlockBuildingOutcome` (sealed header + receipts) and the executed transaction bytes are compacted.
- **Failed and retried attempts:**
  - a failed attempt (pre-Holocene discard, or the first try of a deposit-only retry) records nothing;
  - the deposit-only retry's executed transactions are the ones recorded.
- **Compaction** (`CapturedBlock::compact`; memory O(matching logs)):
  - recomputes `receiptsRoot` with upstream's `compute_receipts_root`, and `transactionsRoot` from the executed EIP-2718 bytes;
  - requires one receipt per transaction;
  - keeps only matching logs, with logIndex = position among ALL logs of the block, and txHash = keccak256(executed tx bytes);
  - any mismatch is recorded and refuses.
- **Never used:** witness- or RPC-supplied log metadata.

## Bound before output (any failure refuses; nothing is truncated)
`build_coverage`:
- exactly n = claimed − agreed captured blocks, numbered agreed+1..claimed;
- the first block's parent hash is the agreed safe head's (from the cursor, which the trusted agreed output root authenticates), then each block's parent is the previous block's hash;
- the sealed hash equals the recomputed header hash;
- `withdrawalsRoot` is present (Isthmus);
- `outputRoot = keccak(0³²‖stateRoot‖withdrawalsRoot‖hash)` equals the executor's own root and `intermediateRoots[i]`;
- logIndex is strictly increasing per block;
- the coverage JSON is ≤ 16 MiB.

**Then:**
- `accept()`: all 10 trusted inputs, roots ending at the claim;
- `bind_head()`: the executed head reproduces the claimed root;
- `coverage_ends_at_head`;
- the full stdout JSON is ≤ 16 MiB.

## What a consumer may conclude (and may not)
**May conclude:** for the L1-finalized anchor that this run's result becomes (after KVM's reader binds it), the set of lease16 events in blocks fromBlock..toBlock is **complete**, because every executed receipt was examined. Contiguous runs (each next run's agreed root = the previous claimed root) extend that coverage.

**May not conclude:**
- anything before the first covered block. Leases whose current `Claimed` is older stay **unproven**: no auto-reclaim, no signature and no label makes them covered;
- anything from a v3 result that KVM's reader has not accepted through its own L1 light-client/journal path. A positive proof still requires a real witness, the root-built binary and accepted-image (SNP) qualification.

## Conflicts KVM must resolve before finalizing (not changed here; KVM tree untouched)
1. **Native stdout bound.**
   - `derived-reader/provider.mjs` `submit` caps native stdout at `65536 + ceil(n/interval)·192` bytes = 411,136 for n = 1800.
   - v3 needs about 560 B per block record plus the logs, roughly 1.0–1.2 MB at n = 1800.
   - For v3 it must use the agreed 16 MiB cap; otherwise every full-range v3 run is refused as oversize output.
2. **Format.** `bindNativeV2` accepts only v2. A `bindNativeV3` must re-check, as defense in depth:
   - `coverage.format`/`filterId`;
   - `fromBlock = agreed+1`, `toBlock = claimed`;
   - `blocks.length = n` with contiguous numbers;
   - `blocks[i].outputRoot` = the i-th 32 bytes of `intermediateRoots`;
   - the last block equals `base`;
   - logs sorted and unique with `blockHash` = their block's hash and `topics[0]` in the filter;
   - then persist the coverage in the journal before publishing, as with anchors.
3. **Memory.** The capture is compacted per block, but the native run's peak RSS with interval 1 over 1800 real Base blocks is **unmeasured**. The 1536 MiB `maxMemoryMiB` default must be qualified on real witnesses.
4. **Durable budget (KVM's 4 GiB, no auto-eviction).** Block records are about 560 B each, about 24 MB/day at 43,200 blocks/day, so about 170 days before the budget is reached (logs add little). Chunk storage/query and the budget policy are KVM's to settle.
5. **Interval 1.** It is required here; KVM's reader already defaults to 1. Any change needs coverage v2.
