# Base anchor bootstrap: audit of PLAN.md §3.3 and the minimal sound path to self-hosted safe/finalized authority

Written 2026-10-25. Source-only.
- **Not done:** no live access, VM, SSH, compiler, download or commit.
- **Stage:** `finality-stage/anchor-bootstrap-review/`. The published copy is under
  `source/ops/rpc-backend-bootstrap/2026-10-25/finality-investigation/anchor-bootstrap-review/`.
- **Report:** `logs/claude-anchor-bootstrap-result.md`.

**Citation roots:**
- `B` = `finality-stage/client-integrity-next/build/src` (base v1.5.1 with the M7 patch); `a/` = upstream copies.
- `R` = `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3` (base-reth v2.5.2, the reth base v1.5.1 links).
- Line numbers are from those trees.

## 1. Findings

**F1, root's issue (CONFIRMED).** PLAN.md §3.3 rebuilds state "for the snapshot head, linked to the anchor by parent
hash". A block hash commits to its parent only.
- An anchor N authenticates N and its **ancestors**, never N+1...
- With anchor N < snapshot head H (the normal case: the anchor is days old), a malicious DB can invent N+1..H, with
  perfectly linked headers, states and receipts.
- **Base makes this exploitable through consolidation.** `AttributesMatch::check` (`B/crates/consensus/engine/src/attributes.rs:274-351`)
  compares parent hash, timestamp, prevrandao, the transaction bytes, gas limit, withdrawals presence, beacon root, fee
  recipient and the 1559/extraData fields.
  - **It never compares state_root, receipts_root, gas_used or the block hash.**
  - A matching existing EL block becomes SAFE (`consolidate/task.rs:277-344`).
  - So invented descendants that carry the real transaction lists but forged state would be labelled safe, then
    finalized (`service/src/actors/derivation/finalizer.rs:36-99`).

**F2 (new): a rebuild is sound only AT N.**
- reth executes blocks from **plain** state.
- For derived blocks, our EL *builds* the payload itself, so nothing external checks its state root.
- Forged plain entries left by the snapshot therefore produce a self-consistent forked header(T). A full rebuild at T
  against that header passes.
- **The full hashing+merkle rebuild must target exactly the authenticated N.** G3's procedure
  (`client-integrity-next/G3-SNAPSHOT-VERIFICATION.md`, "N at or above the snapshot head") also implicitly needs the DB
  to be at N.

**F3: the EL's finalized label is trusted at start.**
- `find_starting_forkchoice` reads the EL's own finalized, safe and latest (`B/crates/consensus/engine/src/sync/mod.rs:39`,
  `forkchoice.rs:70,100,126`), and "Leave the finalized block as-is" (`:235`).
- The snapshot's persisted labels are attacker-controlled.
- There is **no flag** to start derivation at an anchor (the nearest is `--checkpoint.path`, `cli/src/node.rs:231`, for
  pruned bodies only).

**F4: the unwind depth is limited by a prune guard, not by the files present.**
- The download writes AccountHistory/StorageHistory prune checkpoints at the snapshot block 53,048,526
  (`R/crates/cli/commands/src/download/config_gen.rs:42-92`).
- With `Distance(140000)`, `ensure_unwind_target_unpruned` (`R/crates/prune/types/src/target.rs:130-170`) refuses any
  unwind deeper than **140,000 below the latest block**. This holds even though changesets from 52,500,000 are on disk
  (manifest: files 105 and 106).
- Whole-file pruning deletes file 105 once the tip passes 53,140,000 (`retention-review/README.md`).

**F5: what the anchor proves.**
- **The anchor** is `AnchorStateRegistry.getAnchorRoot() -> (root, l2SequenceNumber)` (`B/crates/proof/contracts/src/anchor_state_registry.rs:18`).
- **When it is updated:** `setAnchorState(game)` is permissionless and accepts only a game that is proper, respected,
  finalized, resolved as **DEFENDER_WINS** and newer (`:46-49`; the challenger mirrors this at
  `B/crates/proof/challenge/src/anchor.rs:229-283`).
- **Base's game type** is the TEE+ZK **AggregateVerifier** (`aggregate_verifier.rs`: `rootClaim`, `l2SequenceNumber`,
  `status`, `proofCount`, `expectedResolution`, `resolvedAt`), not the classic FaultDisputeGame.
- **What the root claim is:** OutputRoot v0 = keccak(0³² ‖ stateRoot ‖ messagePasserRoot ‖ blockHash)
  (`B/crates/consensus/protocol/src/output_root.rs:40-57`). For Isthmus headers, messagePasserRoot = `withdrawalsRoot`
  (`B/crates/execution/consensus/src/validation/isthmus.rs:14`).
- **So the trust:** a finalized anchor proves that Base's respected proof system (TEE/ZK verification, the finality
  delay, the Guardian's blacklist/retire/pause power) accepted that output root. **This is the same assumption Base
  withdrawals rest on.**
- **Not local:** the Solidity sources, storage layout, the finality-delay and resolution timing values, and the exact
  AggregateVerifier acceptance rules. The anchor's age must therefore be **measured** at bootstrap, not assumed.

**F6: L1 needs no state rebuild.**
- **Headers:** L1 headers are authenticated backward from the beacon-finalized payload hash.
- **Bodies and receipts:** checked against their roots (M7: `base-l1-verify.patch`; upstream
  `a/.../chain_provider.rs:87-110,207-235` skips header verification under `trust_rpc` and never checks receipts).
- **The anchor read:** a **proof-verified** call against the finalized L1 stateRoot, through the pinned Helios ethereum
  launcher `finality-stage/l1-authority` (own Lighthouse and own reth only, with a provenance-recorded WS checkpoint).
- **Effect:** a forged L1 plain state can only stall the node, by producing an INVALID payload. It can never produce a
  wrong authority answer.

## 2. The sound invariant and the minimal procedure

**Invariant:** *the full plain state is verified at an authenticated block N; every block above N is our own execution
from authenticated inputs; below N only ancestors (headers by recomputed hash links, receipts by root) are trusted.*

1. **A1, anchor (L1 authenticated, at L1 `finalized`).** Read the following through the l1-authority Helios:
   - **On the ASR:** `getAnchorRoot()`, `anchorGame()`, `isGameFinalized(game)`, `isGameRespected(game)`,
     `isGameBlacklisted(game)`, `isGameRetired(game)` and `paused()`.
   - **On the game:** `status() == 2` (DefenderWins), `rootClaim() == root` and `l2SequenceNumber() == N`.
   - **Binding:** the ASR address is config-bound (HOST_DATA in the SNP design) AND cross-checked by an authenticated
     read from the portal `0x49048044…e97e` (`B/crates/common/chains/src/config.rs:496`).
   - **Open address discrepancy:** a test fixture has ASR `0xdb9091e4…`, while the docs (`finality-stage/DESIGN.md:52`)
     have `0x909f6cf4…`. Resolve it ONLY by an authenticated read, never from either note.
2. **A2, header N.** `authenticateAnchor(game, headerN)` (this stage, implemented): it recomputes keccak(RLP(header)),
   requires all the Isthmus fields, and requires the output root to reproduce exactly.
3. **A3, DB to exactly N.** `planBootstrap` (implemented): `reth stage unwind --offline to-block N` (`R/crates/cli/commands/src/stage/unwind.rs:41,153`).
   - **If N > head:** sync forward past N with no authority served, then unwind.
   - **The unwind uses the untrusted changesets** (`execution/mod.rs:557` `take_state_above`). That is acceptable,
     because A4 checks the result completely.
4. **A4, full rebuild at N.** Run `stage drop` on account-hashing, storage-hashing and merkle, then `stage run hashing`
   and `stage run merkle --from 1 --to N` (G3 findings 3: a clear-and-rebuild from plain state, `validate_state_root`
   against header N). Then call `checkRebuild(anchor, {block: N, stateRoot})` (implemented; any other height is refused).
5. **A5, ancestors.**
   - `authenticateAncestors(headers[52,515,705..N], anchor)` (implemented; recomputed hashes, refuses descendants).
   - Receipts roots for the ledger ranges, using `complete-logs.mjs` `assembleCompleteLogs` with a caller-recomputed
     root. **Needs an OP receipt-trie encoder:** Rust exists (`B/crates/execution/consensus/src/proof.rs:13,46`;
     Helios `opstack/src/spec.rs:40`); no JS one does.
   - Historical-state queries below N are **refused**.
6. **A6, derivation restart at N (NEW patch M10, small).** base-consensus gets `--bootstrap.anchor <N>:<hash>`.
   - **At start it refuses** unless the EL head is exactly N with that hash. It then sets the forkchoice
     safe = finalized = N, ignoring the EL's persisted labels (F3).
   - **It clears the snapshot's safe-head/checkpoint DB.**
   - Pipeline `initial_reset` then walks back `channel_timeout` from N's L1 origin (`derive/src/pipeline/core.rs:51-104`),
     over M7-verified L1.
7. **A7, ongoing tripwire (in M5).** Every newer finalized anchor must equal our chain: `authenticateAnchor` against our
   own header at its height. A mismatch halts the authority (refusal). This sits alongside the M6 sequencer cross-check.
8. **Serving gate.** Until A1–A6 pass and derivation has caught up, the authority API **refuses**.
   - **Writer fencing is unchanged:** claim ≤ L2 finalized, which now comes from our own derivation.
   - Consumers stay on their explicit existing mode. **There is no silent fallback.**
   - **Admin controls are unchanged:** the owner runs, stops and rolls back the offline bootstrap.

## 3. The current snapshot (head 53,048,526, ≈ 2026-10-24T00:00Z), concretely

| path | condition | extra trust | verdict |
|---|---|---|---|
| **U1: unwind to the current anchor, no config change** | the latest block − N ≤ 140,000 (F4) | none beyond A1 | works if the anchor is < ~3.2 days old at that moment. **The age is unknown locally; measure it in A1.** |
| **U2: unwind deeper** | set account/storage history to `Before(52500000)`, so the Distance guard does not apply, before file 105 is pruned (tip 53,140,000) | none | **needs root decision R1.** About 3.7 GB/day more changesets until A4 passes |
| **W: hold, then wait.** **HOLD** a head H*: either stop advancing, or retain changesets from a fixed block (e.g. `stateHistoryFromBlock`). Then wait until a finalized anchor N ≥ the held floor exists, and unwind to N | none | no snapshot history beyond the held floor | **viable ONLY while the floor is held.** A continuously advancing tip with rolling `Distance` pruning moves the floor up with it and is **not guaranteed** to ever meet an anchor (the anchor lags by the finalization delay) |
| E: an earlier snapshot | another multi-TB download | none | not allowed now; worse than U or W |
| C: an independent reviewed checkpoint (sequencer-signed head, or a provider agreement) | the sequencer key or providers | immediate | **never a finalized or cryptographic label.** At most a root-reviewed, separately labelled bridge. Not recommended |

**Bootstrap trust (one-time):**
1. The L1 weak-subjectivity checkpoint, ≥ 2 recorded sources (l1-authority; Helios caps its age at 14 days).
2. The Base anchor game (F5).
3. The pinned client binaries (their provenance gates are separate).
4. The config-bound ASR and portal addresses.

**Ongoing:**
- **None of the public RPC.** Our own L1 EL/CL comes from p2p; Helios and Lighthouse supply L1 finality; L2 derivation
  runs over M7-verified L1.
- **Sequencer gossip** is a tripwire and an unsafe-head source only.
- **Later anchors** are a tripwire only. After A6, finality never depends on games again.

**Not provided by this (stated):**
- **Not SNP authority.** In plain KVM it protects against snapshot and DB forgery, not against the host. Authority
  against the host needs the separately reviewed SNP conversion.
- **Unmeasured costs:** the A3/A4 cost on the Base HDD (a 1.1 TB plain-state rehash; gate G6).

**Root status (2026-10-25 follow-up):**
- **Retention candidate selected:** `stateHistoryFromBlock 52500000` (6d24, in preparation), plus `historyFromBlock 48000000`
  for the legacy book. That holds the changeset floor at 52,500,000, which is what U2 and W need.
- **Base is currently disabled.** Only the dc9f runtime receipts guard is installed; there is no config policy yet.

## 4. Decisions and blockers (exact)

| id | what | owner |
|---|---|---|
| **R1 (time-critical)** | Hold the changeset floor at 52,500,000 until A4 passes. Root's candidate is `stateHistoryFromBlock 52500000`; the equivalent pinned flags are `--prune.account-history.before`/`--prune.storage-history.before 52500000`. **Either is needed BEFORE the Base node runs with rolling `Distance(140000)` past 53,140,000.** Without a held floor, only U1 remains (and W only with a held head) | root (candidate selected; 6d24 preparing) |
| R2 | Run A3+A4 in place on the Base DB with the VM stopped (the DB is untrusted anyway; a failure means re-download), or on a copy. A copy does not fit: `/vm` has ≈ 527 GB after L1 | root |
| B-A1 | L1 must be synced, so that Helios can prove `finalized` calls through our own reth: wait for own EL/CL catch-up. Measure the anchor age then | ops |
| B-M10 | The A6 patch (forkchoice from the anchor plus clearing the safe-head DB) | Rust, native build later |
| B-RCPT | The OP receipts-root encoder (A5): Rust reuse in the coverage `kzgcheck` lineage, or a JS port | small |
| G6 | Measure the A3/A4 time on the HDD | ops |

**PLAN.md §3.3 must be replaced by §2 above.** Its line "recompute hashing and merkle for the snapshot head, linked to
the anchor by parent hash" is unsound as written.

## 5. Implemented here (tested; no decisions needed)

**`anchor-bootstrap.mjs`** (pure, keccak injected):
- `headerRlp` / `headerHash` (Ethereum and OP header field order, contiguous fork-suffix rule);
- `outputRootV0`;
- `authenticateAnchor`;
- `authenticateAncestors` (refuses descendants);
- `planBootstrap` (never accepts above N; unwind, sync-past-then-unwind, or wait);
- `checkRebuild` (only at N).

**`test/anchor-bootstrap.test.mjs`:** 5/5 (queue 256). It includes:
- **the published mainnet genesis header hash `0xd4e56740…8fa3`**;
- **byte-equality with viem 2.53.1's independent `toRlp`** for an Isthmus header;
- forged state root, message-passer root and header field; a lying `hash` claim; a pre-Isthmus header;
- **invented descendants above N refused**; a tampered ancestor refused even with a "linking" stored hash; a gap;
- every planner branch;
- a rebuild at a later tip refused.

**Limit:** there is no real Base Isthmus header vector offline. The encoder agrees with viem and the genesis vector;
the A2 run on the real header N is the end-to-end check.
