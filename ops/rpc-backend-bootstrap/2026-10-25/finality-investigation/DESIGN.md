# Finalized lease fencing and complete log history without public RPCs (finality-stage)

Written 2026-10-25. Source-only and read-only. No source tree was edited, nothing live, no SSH, no keys, no builds, no images, no commits.
Report: /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/claude-finality-feasibility-result.md

## 0. The gap

`relay/lease-generation.mjs` (relay-consumer-source) fences writers on three things:
1. **The finalized number.** `finalized` is the minimum over the agreeing peers of `eth_getBlockByNumber("finalized")`, capped at B (lines 232, 250).
2. **Claim finality.** The claim's block must satisfy `C.blockNumber <= finalized` (line 309).
3. **Complete history.** It needs every Claimed, Renewed and Released log from the last Claimed up to B, from two agreeing RPCs (lines 194-206, 264-295).

Today (1) and (2) rest on an **unsigned label** and (3) on **agreement between providers**. Neither is a proof.

On the pinned verifier (Helios eeffcc9 lineage; inspected copy at `resume-after-checkpoint-20261022/rpc-runtime-final-integration/closure/check-work/helios`):
- **No finalized block.** `opstack/src/consensus.rs` creates `finalized_block_send` but never sends on it. Only `block_send` is fed, from the sequencer-signed unsafe commitment (`Inner::advance`). So "finalized" is **absent** there, not just unproven. Substituting the unsafe head would be silent fencing removal.
- **Inclusion, not completeness.** `core/src/execution/providers/verifiable_api.rs:305` checks that each returned log is in a receipt whose receiptsRoot is verified. A block the backend leaves out is never checked.

## 1. Operational readiness is not finality authority

| | Operational readiness (needed to serve data) | Cryptographic finality authority (needed to fence) |
|---|---|---|
| What it is | Own reth+Lighthouse L1 pair and Base node synced. Safe/finalized labels come from base-consensus derivation. `coverage-stage` verdict is `COVERED`. | A chain of verifications from a pinned weak-subjectivity checkpoint down to the lease's logs. |
| Who signs | Nobody. The labels are our own process's database (`ChainState[LastFinalizedBlock]`, see coverage-stage/RESULT.md §2). | Ethereum sync committee signatures, then L1 state proofs, then a Base proof game finalized on L1, then hashes. |
| Fails as | Lag or unavailability. | A refusal: `claim_not_final`, `incomplete` or `anchor_mismatch`. Never an older or empty history. |

The own full node stays the **untrusted data source** for headers, receipts and proofs. It is never the source of the finality label.

## 2. The authority chain, link by link: supported or new

| # | Link | Pinned local code | Status |
|---|---|---|---|
| A | **L1 finalized execution block.** Beacon light client: bootstrap from a checkpoint, then sync-committee updates and `verify_finality_update`. | Helios `ethereum/src/consensus.rs` (lines 440-485, 544); `consensus-core/src/consensus_core.rs:72`. Fork config includes Fulu and Gloas. Lighthouse v8.3.2 serves `/eth/v1/beacon/light_client/{bootstrap,updates,finality_update,optimistic_update}` by default; only `--disable-light-client-server` turns it off (`beacon_node/src/config.rs:202,1497`; http_api lib.rs:1760-1850). | **Supported code, not wired.** See the hazards below this table. |
| B | **Finalized Base output root on L1.** Read through Helios-ethereum verified `eth_call` and storage proofs at the finalized L1 block. | ABI only: base v1.5.1 `crates/proof/contracts/src/anchor_state_registry.rs` (`getAnchorRoot`, `anchorGame`, `isGameFinalized`, `isGameBlacklisted`, `isGameRetired`, `isGameRespected`, `paused`, `respectedGameType`) and `aggregate_verifier.rs` (`rootClaim`, `l2SequenceNumber`, `status`, `resolvedAt`, `gameOver`, `proofCount`, `l1Head`). | **New** (small). |
| C | **Output root to L2 block hash.** v0 = keccak(0^32 ‖ stateRoot ‖ messagePasserStorageRoot ‖ blockHash). | `crates/consensus/protocol/src/output_root.rs:44-56`. Base's own challenger does exactly this in `crates/proof/challenge/src/validator.rs:213-234`: it recomputes the header hash, then verifies an account proof of L2ToL1MessagePasser against `header.state_root`. | **Supported pattern.** Port it, or call it from the Rust side. `finality-stage/complete-logs.mjs: outputRootV0/anchorFromOutputRoot` is tested. |
| D | **L2 header chain down to the claim.** parentHash linkage from the anchor block hash. | Helios opstack converts payloads and hashes blocks. Base header encoding is available through alloy/op-alloy in the pinned Rust. | **New**, and the linkage logic is done: `planCompleteScan` (tested). The caller must recompute every header hash from its RLP. |
| E | **Complete logs.** Every block where `logsBloom` contains the ledger address, the id and one lease topic0 has its full receipt list fetched, and receiptsRoot is recomputed. Blooms have no false negatives, so skipping the other blocks is sound. | Helios opstack `spec.rs` encodes OP receipts for the receipt trie, which is what `verifiable_api` uses. coverage-stage kzgcheck recomputes roots for **L1** types only (no 0x7E deposit receipts). | **New**: a range API. Plan and assembly are done: `assembleCompleteLogs` (tested). The receipt-root recomputation must reuse Helios opstack's encoding. |
| F | **Unsafe tail (anchor → current B).** Walk parentHash from the sequencer-signed Helios head back to the anchor hash. Logs in that tail are complete the same way, but labelled **unsafe** (sequencer-signed). | Helios opstack `block_send` and the unsafe signer. | **New** (linkage reuses D). The semantics are unchanged: today too, only the CLAIM must be final; later Renewed and Released logs above finality are already accepted. |

**Hazards in link A:**
- `opstack::verify_unsafe_signer` builds its L1 client from `eth_network.to_base_config()`. Mainnet's default `consensus_rpc` there is the public `https://ethereum.operationsolarstorm.org` (`ethereum/src/config/networks.rs:84`), and the opstack config exposes no override for it. Enabling `verify_unsafe_signer` as pinned would therefore contact a **public beacon endpoint**. That is forbidden, so do not enable it unchanged.
- The default checkpoint is hard-coded, and `max_checkpoint_age` is 14 days. A fresh checkpoint with ≥2 provenance sources is needed; that is D4 of the L1 package.
- Link A needs the local L1 EL to serve `eth_getProof` at the finalized block. reth `--full` keeps recent state, which is enough for the finalized head.

**Hazard in link C (history):** `eth_getProof` for the message passer at an **old** anchor block needs state the Base full node may have pruned. Fetch and store the proof when the game is **created** (the block is fixed then). Verify it after the game finalizes. If the proof is missing, refuse.

## 3. Residual trust, stated honestly

- **The checkpoint.** A weak-subjectivity checkpoint root, pinned by root with provenance.
- **The light-client assumption.** The sync committee is honest; this is weaker than full Casper FFG verification. It is a light-client authority, **not** "locally proved Ethereum".
- **Base's proof system.** AggregateVerifier (TEE + ZK) and AnchorStateRegistry are correct, and their upgrade keys are not abused. Mitigation: read the EIP-1967 implementation slots of the registry, factory and game impl through link A, pin them, and fail closed on any change (`unsupported_proof_system`).
- **Contract addresses.** AnchorStateRegistry `0x909f6cf4…4E72` comes from docs.base.org (memory `base-p2p-witness-audit`). Derive it on-chain via SystemConfig/OptimismPortal through verified reads, and pin it. It is not established locally.
- **Data availability.** The single site and the own backend can refuse to serve, which fails closed (unavailable). They cannot forge.

## 4. Latency: the decision root must make

With links A to E, a claim is fenceable only once a **finalized** game covers a block ≥ the claim. That depends on on-chain parameters: proposal cadence (`BLOCK_INTERVAL`, which changes at Denim), challenge and resolution windows, and the registry's finality delay. **None of them is established in local source.** Read them through link A before committing to an SLO. Expect this to be much slower than today's 15-30 min label. Until then `writerAuthority` returns `claim_not_final` (retry), and the guest keeps its own measured path (`refusingWriterAuthority` semantics).

**Not offered as equivalent** (each would have to be labelled distinctly if root wants it):
- **B2: proposed, unresolved game.** A game whose `l1Head` is L1-finalized and that has a verified TEE/ZK proof, but is not yet finalized or resolved. It can still be challenged or nullified, so it is **not finality**. Its label would be "Base-prover-attested proposal".
- **Fresh derivation finality (about 15-30 min).** This requires running base-consensus derivation (`crates/consensus/derive`) over L1 data verified by link A, **and** executing the L2 blocks to get receipts. That is a full node. Its output is operational, or at best "attested execution" in a measured image. It is **not** a cryptographic proof, and pinned code has no light derivation verifier.
- **Not acceptable at all:** a remote mutable server, our own `finalized` label, provider agreement, or the sequencer-signed head treated as final.

## 5. Smallest safe implementation (new code only, after root review)

1. **`l1-authority` (Rust).** A thin binary on pinned Helios `ethereum`:
   - consensus_rpc is the loopback Lighthouse only, and external fallback is off;
   - it takes a pinned checkpoint;
   - it exposes `finalizedL1() -> {number, hash, stateRoot, slot}` and the verified reads of §2B and the EIP-1967 pins;
   - it refuses when the finality update is older than N epochs.
2. **`base-anchor` (Rust, same binary).** It does the following:
   - selects the newest game where all of these hold: `isGameFinalized && !blacklisted && !retired && respected && status == DEFENDER_WINS`, and the registry is not paused;
   - returns `{l2Number, rootClaim}`;
   - verifies the stored header and message-passer proof (§2 hazard C) with the challenger's algorithm, then emits `anchor {number, blockHash}`.
3. **`complete-logs` range service.** It fetches headers and receipts from the own Base node, recomputes the header hash and the OP receiptsRoot (Helios opstack encoding), and uses `finality-stage/complete-logs.mjs` (or its Rust port) for linkage, bloom planning and fail-closed assembly. It persists **verified** coverage keyed by the anchor hash.
4. **Lease-generation integration.** This is a proposal patch only; the relay worker owns it:
   - add a reader mode that takes `{anchor, logs, unsafeTail}` from 1-3 in place of `rpcs`;
   - set `finalized := anchor.number`, labelled `base-proof-finalized/light-client`;
   - the claim must be ≤ anchor; the replay is unchanged;
   - the current two-RPC mode stays available only where root keeps it. It is never a silent fallback.

**Tests to add with 1-4:**
- Light client: the Helios consensus-core spec vectors are present (`consensus-core/testdata`). Add a recorded Lighthouse LC fixture and negatives: a bad signature, a stale finality update, a wrong fork digest, and a checkpoint past `max_checkpoint_age`.
- Game selection: blacklisted, retired, unrespected, paused, CHALLENGER_WINS and not-final games are each refused. An implementation-slot change returns `unsupported_proof_system`.
- Output root: a real Base mainnet header plus message-passer proof, recorded offline with root approval, reproduces a real game's rootClaim. A mutated byte is refused.
- Complete logs: a backend that omits a bloom-positive block's receipts returns `incomplete`. A reordered or forged receipt returns `receipts_root`. A forked header returns `unlinked`. A bloom-negative skip is cross-checked against the full receipts of a recorded range.
- Lease replay: a claim above the anchor returns `claim_not_final`. A Released log in the unsafe tail is caught.

## 6. What is in this stage

- `complete-logs.mjs`: pure, no imports, keccak injected. It covers bloom membership (yellow paper M3:2048), header linkage to the anchor, the bloom-candidate plan, fail-closed assembly, and output-root v0 to anchor.
- `test/complete-logs.test.mjs`: 6/6 pass under the shared queue at 256 MiB. Logs: `../logs/finality-stage-test.{out,guard,rc}`; the first attempt with a bad invocation (directory argument) is kept as `finality-stage-test.try1.out`.
- **Not done:**
  - mutation testing;
  - real Base header and receipt vectors;
  - header RLP and OP receipt-root recomputation (left to the Rust side, which reuses pinned encoders);
  - all of §5 items 1-4.
