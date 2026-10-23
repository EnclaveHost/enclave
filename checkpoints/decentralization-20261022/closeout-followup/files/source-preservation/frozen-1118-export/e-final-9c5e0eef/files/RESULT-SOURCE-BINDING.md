# Source binding of transaction verification + the app-funding decision (2026-10-23)

Source and offline tests only.
- **Not done:** no live endpoint, SSH, wallet, signing outside local fixtures, funding, contract deploy, push, toolchain
  or sync.
- **Trees:** P, S, B, A and F were not edited (file handoff only).
- **Author and committer:** SteveDeFacto.
- **Earlier work preserved:** `a460c36c`, `159fd148`, `017b8aae`, `027ff549` (26 pass / 27 mutants), `ca818b75`. The
  single-provider capture limitation stands.

## Commits

| commit | content |
|---|---|
| `a194afe28dbf39f6716c415cc4609e00f25ea9a7` | source binding: adapters, evidence minting, checks require minted evidence, tests, proposal, handoff, artifact recipe |
| `46dbfbef32a25e23c7d1045f2458f00a7470cb32` | **final source**: tracker unit test on test-labels; mutants 11/17 re-pointed |
| (this report and the D export) | follow-up commit |

**Source file sha256 at `46dbfbef`:**

| file | sha256 |
|---|---|
| `src/evidence-brand.mjs` | `e0aa7363…` |
| `src/l1-source-binding.mjs` | `d4a48790…` |
| `src/base-source-binding.mjs` | `5b5922b3…` |
| `src/forced-inclusion.mjs` | `438e9c77…` |
| `src/vault-deposit.mjs` | `a0401e08…`, unchanged |
| `src/lease-signing-policy.mjs` | `30cfd9e7…`, unchanged |

## What changed: a label is no longer evidence

Before this change, `matchDepositEvent`, `checkPortalPin`, `resolveFailedL1`, `classifyL2Outcome` and
`classifyFinality` accepted any object whose `verifiedBy` string was in an allowlist. Now, by default, they accept only
objects **minted** by a read adapter (`src/evidence-brand.mjs`, a module-private WeakSet). Each must also:
- be of the expected kind;
- carry an accepted `trust`;
- for receipts, be the very receipt object the adapter returned.

Explicit `verifiers` lists are accepted only for `test-*` labels. `verifiers: ['l1-execution-proof']` is refused
(`labels-are-not-evidence`).

The minting is an in-process capability, not cryptography. It stops callers, config files and endpoints from asserting
evidence. It does not stop code inside the same process.

### `createL1PairSource` (`src/l1-source-binding.mjs`): bound to P's reth + Lighthouse pair

Every read is from the two configured loopback endpoints only: non-loopback, credentials, or the same URL for both
clients is refused, and there is no fallback list. Before every evidence read it checks readiness, which is P's
`l1pair.py ready` fact set:

| side | checks |
|---|---|
| EL | chain 1, mainnet genesis `0xd4e5…8fa3`, `eth_syncing` false, peers ≥ 1, head lag ≤ 120 s, finalized present and lag ≤ 1 h, safe present |
| CL | GVR `0x4b36…fe95`, not syncing / optimistic / EL-offline, peers ≥ 1 |
| **PAIRING** | the beacon finalized payload `(block_number, block_hash)` is the EL block at that number AND the EL's `finalized` block; the beacon head payload is the EL block at that height |

- **`receipt(txHash)`:**
  - binds receipt ↔ transaction (`eth_getTransactionByHash`: nonce, from, blockHash) ↔ block (by hash, listing the tx);
  - re-checks readiness AND the canonical hash at that number AFTER the read: a reorg is refused, a regressed
    finalized checkpoint is refused, a missing receipt is `pending`;
  - `finalized` comes only from the paired finalized checkpoint.
- **`portalSnapshot(portal)`:** reads the EIP-1967 implementation and `version()` pinned to the paired finalized block.
- **Trust:**
  - `local-validated-pair` only for the mainnet identity: local full-node validation. reth executed every block from
    genesis; Lighthouse follows consensus from its weak-subjectivity anchor (P's checkpoint provenance). It is not a
    portable proof.
  - Anything else mints `test-fixture`, which the defaults refuse.
  - `minPeers: 0` is refused for mainnet.

### `createBaseNodeSource` (`src/base-source-binding.mjs`): bound to S's Base holder AND the same L1 adapter

- **Readiness:**
  - chain `0x2105`, genesis `0xf712…73dd`, `eth_syncing` false;
  - `optimism_syncStatus` (snake_case; field names from base/base v1.5.1 `crates/consensus/protocol/src/sync.rs`) with
    a fresh unsafe head;
  - unsafe, safe and finalized heads are the EL's blocks;
  - the node's `current_l1` must be canonical, and `finalized_l1` canonical AND final, in OUR L1 pair. A holder
    deriving from another L1 is refused.
- **`receipt(txHash)`:** canonical re-check after the read; `level` = finalized / safe / unsafe from the node's heads.
- **`classifyFinality`** returns `finalized` only if the L2 receipt's block is derivation-finalized AND the deposit's
  L1 block is final in the pair (`depositL1Final`).

**Never upgraded:** an unsafe head (sequencer-signed), a Sia or archive history entry, a send reply, a Helios label.

## Tests (actual runs)

**Final suite:** **32/32 pass** on `46dbfbef` (`logs/final-sb2-suite.out`, one 512-MiB job, peak 337 MiB). That is the
previous 26 plus 6 new.

- **`source-binding.anvil` (4), the adapters over real components:**
  - **L1:** anvil running the PRODUCTION portal bytecode (single-provider capture). It started at the captured block
    and is labelled with a FIXTURE CLOCK and identity.
  - **L2:** real lease contracts.
  - **Fixtures:** a LABELLED beacon fixture (mirrors anvil's tags; NOT Lighthouse) and a LABELLED `optimism_syncStatus`
    fixture.
  - **Shown:**
    - configuration refusals: public URL, same URL, a Base source without an L1 source, mainnet identity with
      `minPeers 0`;
    - the mainnet identity refuses the anvil fixture (genesis, GVR, peers);
    - a forced lease read back only through minted evidence. The default trust refuses the fixture; a spread copy and a
      foreign receipt are refused. Then deposit match → real L2 execution → Base evidence: **unsafe → safe (L2
      finalized while the L1 deposit block is not final) → finalized after the L1 pair finalizes it**;
    - fail closed on: an unpaired beacon (a payload that is a real EL block but not the EL's finalized block); syncing,
      optimistic, EL offline; no peers; a stale head; a Base node on another L1; a reorged-away receipt (`pending`, not
      evidence);
    - nonce and resend binding uses the node's nonce.
- **`source-binding` (2), scripted control flow** (labelled stubs):
  - a pair reporting mainnet identity on loopback mints `local-validated-pair`. The configured loopback pair is the
    trust anchor; that is stated, not hidden;
  - reorg between reads → `l1-not-canonical`; another tx's receipt, or a tx not in its block → `l1-receipt-mismatch`;
    no finalized tag → not ready.
- **Updated** for "labels are not evidence":
  - `finality` (1): labelled JSON refused;
  - `forced-inclusion` (6): `helios` label refused by default and when whitelisted;
  - `tracker` (1): production-label JSON refused.

**Mutation controls:** **36/36 killed.**
- The original 10 (`logs/final-sb.out`).
- 26 closure mutants: 16 earlier plus 10 new for minting, trust, receipt identity, pairing, canonical re-check, the
  Base L1 view, loopback-only, beacon sync flags, block-lists-tx and test-only labels.
- Mutants 11/17 first survived because they pointed at suites that no longer exercise those guards. Re-pointed to the
  source-binding suite and killed (`logs/final-sb2.out`).

**Earlier failed runs, kept as evidence:**
- `bind-1`: an `await` syntax error.
- `bind-2`: stopped while queued, never started.
- `bind-3`: anvil fixture plumbing (genesis number, `net_peerCount`, clock, finalized depth).
- `bind-4` / `final-sb`: a stub reorg modelling error; the tracker test on old labels.

**Scans:** crypto-key scan clean, gitleaks no leaks.

## What can run once the resource gate closes (no code change needed)

1. P's pair synced, with `l1pair.py ready` passing → `createL1PairSource({execution:{url:'http://127.0.0.1:18645'},
   consensus:{url:'http://127.0.0.1:15052'}})`. Its `readiness()` must be ok.
2. S's holder deriving from that pair → `createBaseNodeSource({execution:{url}, rollup:{url}, l1})`.
3. Read only, before any signing: `checkPortalPin(await l1.portalSnapshot(portal), {portal, implementation:
   0x03863ab7…, versions:['6.0.1']})`. This is the first validated (not provider-claimed) reading of the production
   portal pin.
4. The forced path: plan (unsigned) → signed elsewhere → P's opt-in local broadcast → `l1.receipt` →
   `matchDepositEvent` → `base.receipt` → `classifyL2Outcome` / `classifyFinality`.

**Still a gate, not claimed:**
- the pair actually synced;
- real Lighthouse/reth behaviour on these exact calls (P's binary-closure tests);
- the Base holder's rollup RPC port and `optimism_syncStatus` from the real binary;
- any portable proof. Full-consensus evidence is explicit only once P's live pair is synchronized.

**Handoff:** `HANDOFF-SOURCE-BINDING.md` gives the exact RPC surfaces for P and S, the wiring for B, and the display
rules for A. The earlier `NOTE-FOR-P-L1-BROADCAST.md` stands.

## App-funding decision (`PROPOSAL-FORCED-INCLUSION-COMPENSATION.md`)

- **Routine Base broadcast fees** are app-funded today: the reserve's `finish()` formula covers the normal relay path.
- **Emergency forced-inclusion L1 fees** are NOT, and the existing contracts cannot make them automatic:
  - The reserve pays only through `finish()`, where `tx.gasprice` is 0 for deposits (measured coverage 3.8e-6), or
    through the owner's own `withdraw`.
  - That `withdraw` is keyed to `msg.sender` and refused mid-operation. There is no allowance, delegate or module path.
  - SessionVault-owned apps reach the reserve only through the DIRECT-ONLY `ownerCall`, and session keys have no
    reserve action.
  - The only existing workaround is an owner-prepaid FLOAT: one owner signature per float, to a TRUSTED submitter. It
    pays L2 ETH, while the submitter needs L1 ETH (about 7 days back through the canonical bridge).
- **Lease continuity delay** (up to 43,200 s against a 1,800-s lease) is protocol-bound and unchanged by any payment.
- **Minimal proposal** (additive, not implemented, not deployed): an optional `EnclaveForcedLeaseCompensator`. Called
  by the deposit, it runs the existing executor's lease and atomically pays the host-named submitter from the owner's
  own escrow. The payment is bounded by the operator-signed `ForcedTerms`, the owner's caps, and an L1Block-basefee
  estimate.
  - The proposal includes the unsigned call and permission inventory, plus the liquidity, race, estimate and admin
    requirements.
  - **No funding or authorization is requested now.** The decision is external (root / contract owners).

## D source preservation

- `exports/source-only/`: `git format-patch` of all commits, EXCLUDING compiled fixture artifacts
  (`fixtures/artifacts/*.json`) and bytecode captures (`evidence/capture/*.json`).
- `exports/source-only/ARTIFACT-RECIPE.json` (`tools/artifact-recipe.mjs`) pins each omitted file:

  | omitted file | pinned with |
  |---|---|
  | each of the 13 compiled artifacts | origin path, sha256, solc 0.8.35 settings, source keccak, runtime keccak, links |
  | the 2 captures | spec, block, provider, account code hashes |

- Old history is not rewritten.
