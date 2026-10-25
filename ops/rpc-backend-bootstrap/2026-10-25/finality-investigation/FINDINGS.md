# Finality and complete-log feasibility: FINAL report

Written 2026-10-25. Read-only source investigation. No existing source was edited. Nothing live, no SSH, keys, network installs, builds, images or commits.
Owned new files:
- /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/{DESIGN.md, complete-logs.mjs, test/complete-logs.test.mjs}
- logs/finality-stage-test.{out,guard,rc,try1.out}

## Verdict

- **Feasible.** Finalized lease fencing and complete log history can both be kept without a public RPC and without trusting our own backend's finality labels. The chain is: L1 beacon light client → verified L1 reads of a **finalized** Base proof game → output root → L2 header chain → bloom-guided, receiptsRoot-verified receipts.
- **Not available today.** No step of it is wired anywhere today. Most links have pinned local code, but the range-completeness logic, game selection and integration are **new work**. A small, tested core of it is staged (6/6).
- **The cost is latency.** Under this authority a claim becomes fenceable only after a Base game covering it is **finalized on L1**. That delay comes from on-chain parameters that were not established locally, and it will be far longer than today's 15-30 min `finalized` label. Root must accept that availability change explicitly. It is not a silent fencing change: until then the reader refuses with `claim_not_final`.

## Facts established (file:line)

1. **What lease-generation trusts today.**
   - The finalized number is an unsigned per-peer `eth_getBlockByNumber("finalized")` label, taken as the minimum over agreeing peers (`relay/lease-generation.mjs:232,250`).
   - The claim must be ≤ that number (`:309`).
   - History completeness is agreement between two RPCs (`:194-206`).
2. **The pinned Helios opstack has no finality.** `opstack/src/consensus.rs` creates `finalized_block_send` and never sends on it. Only sequencer-signed unsafe heads flow (`Inner::advance`). Helios `verifiable_api.rs:305` `get_logs` proves inclusion only.
3. **An L1 light client with finality exists in pinned code.** Helios `ethereum` (`consensus.rs:440-485`, `verify_finality_update` at `:544`, consensus-core spec vectors). Fork config includes Fulu and Gloas.
4. **Hazard: do not enable `verify_unsafe_signer` as-is.** It builds its L1 client from network defaults, and mainnet `consensus_rpc` defaults to the public `ethereum.operationsolarstorm.org` (`ethereum/src/config/networks.rs:84`). The opstack config has no override for it. The default checkpoint is hard-coded, with `max_checkpoint_age` 14 days.
5. **The local L1 can serve a light client.** Pinned Lighthouse v8.3.2 serves the light-client REST API by default; it is disabled only by `--disable-light-client-server` (`beacon_node/src/config.rs:202,1497`; http_api `lib.rs:1760-1850`). Its live reachability was not tested (no live access).
6. **Base's on-L1 finality objects.** These are base v1.5.1 bindings, used here as ABI reference only:
   - `AnchorStateRegistry`: `getAnchorRoot`, `isGameFinalized`, `isGameBlacklisted`, `isGameRetired`, `isGameRespected`, `paused`;
   - `AggregateVerifier` (TEE + ZK): `rootClaim`, `l2SequenceNumber`, `status`, `l1Head`, `proofCount`.

   Proposal intervals change at Denim (`proof/proposer/src/proposal_intervals.rs`). Resolution and finality delays are on-chain parameters and are not in local source.
7. **Output root to L2 block hash is an existing Base pattern.** OutputRoot v0 is defined at `consensus/protocol/src/output_root.rs:44-56`. Base's challenger does: recompute the header hash, prove the account of the message passer against `header.state_root`, then hash the output root (`proof/challenge/src/validator.rs:213-234`).
8. **Scope of the existing coverage helper.** coverage-stage (`kzgcheck`) cryptographically recomputes L1 header, transaction and receipt roots and blob KZG commitments. It still takes beacon roots and canonicality from our own Lighthouse, and its root encoders are L1 types only. That proves data availability for derivation, not Base finality or Base log completeness.

## Operational readiness vs cryptographic finality authority

- **Operational readiness:**
  - synced L1 pair and Base node;
  - coverage `COVERED`;
  - base-consensus safe/finalized labels.

  These are needed to **serve** the data, and they remain untrusted.
- **Cryptographic authority:** pinned checkpoint, then sync-committee finality, then verified L1 reads, then a finalized game, then hashes. Only this may set `finalized` for fencing.
- **Residual trust:** the checkpoint's provenance; the light-client (sync committee) assumption; correctness of Base's proof system and upgrade keys (pin the EIP-1967 implementations, fail closed on change); the AnchorStateRegistry address (docs value `0x909f6cf4…4E72` is not established locally, so derive and pin it via verified reads).

## Supported vs new

**Supported in pinned code:**
- Helios ethereum light client and verified L1 `eth_call`/proofs;
- Lighthouse light-client API;
- OutputRoot v0 and the challenger's verification algorithm;
- OP receipt-trie encoding in Helios opstack (`spec.rs`);
- the proof-contract ABIs.

**New:**
- **L1 authority process** wired to loopback Lighthouse only, with a pinned checkpoint and no fallback.
- **Game selection** over the finalized and eligibility flags.
- **Message-passer proof capture** at game creation. The Base full node may prune state for old anchor blocks; without the proof, refuse.
- **Range service** that recomputes Base header hashes and OP receipt roots.
- **Unsafe-tail linkage** from the signed head back to the anchor.
- **Lease-generation reader mode.** The relay worker owns it; it is a proposal only and must never be a silent fallback.

**Staged and tested now:** `complete-logs.mjs` covers:
- bloom membership (M3:2048);
- `planCompleteScan`: contiguity, parentHash linkage to the anchor, and listing bloom candidates;
- `assembleCompleteLogs`: an omitted candidate returns `incomplete`, a mismatched root returns `receipts_root`, a log naming another block returns `bad_input`;
- `outputRootV0` / `anchorFromOutputRoot`.

Tests are 6/6 under the shared queue at 256 MiB, `rc=0` (logs/finality-stage-test.out). The first attempt failed only because node was given a directory argument; it is kept as `.try1.out`.

**Not done:**
- mutation testing;
- real Base vectors;
- header RLP and receipt-root recomputation in this module (deliberately left to the pinned Rust encoders).

## Smallest safe implementation, and the tests

See DESIGN.md §5. In short:
1. The Helios-ethereum `l1-authority` plus `base-anchor` binary.
2. The complete-logs range service using the staged module.
3. A reader-mode proposal for lease-generation: `finalized := anchor.number`, labelled `base-proof-finalized/light-client`.

The tests are listed in DESIGN.md §5: LC negatives, game-eligibility negatives, a real recorded rootClaim reproduction, omission, forgery and fork refusal, and claim-above-anchor returning `claim_not_final`.

## Explicitly unsupported or rejected

- **Fresh (~15-30 min) cryptographic Base finality.** It needs derivation **plus** L2 execution, which means a full node. Pinned code has no light derivation verifier. A measured node could at most be labelled "attested execution".
- **A proposed but unresolved game as finality.** It can be challenged. If root wants it at all, it needs a distinct label.
- **Fake equivalents.** A remote mutable server, our own `finalized` label, provider agreement, or the sequencer-signed head are not equivalent to finality.
- **No upgrade claims.** None are made: on-chain delays, the registry address and the live Lighthouse light-client serving all remain unverified locally.
