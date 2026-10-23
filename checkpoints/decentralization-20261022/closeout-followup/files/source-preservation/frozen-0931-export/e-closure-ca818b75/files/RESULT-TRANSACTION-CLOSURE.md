# Transaction closure: the forced-inclusion path's missing pieces (2026-10-23)

Source, bounded read-only research captures and offline tests only.
- **Not done:** no live chain writes, no wallet, no funding, no SSH, no VM or storage allocation, no new account, no
  purchase, no toolchain install, no full sync, no contract deploy or change, no push. Test keys signed only on local
  anvil chains.
- **Trees:** A, B, P, S and F were not edited. P gets a file note only (`NOTE-FOR-P-L1-BROADCAST.md`).
- **Author and committer:** SteveDeFacto.

## Commits (append-only; earlier source and report preserved)

| commit | content |
|---|---|
| `a460c36c88f41b95e6c2c8f27f7083a4415917c7` | original planner (preserved) |
| `159fd1480ddab9652043cce5163348ff4fa6996b` | original report (preserved) |
| `017b8aae5baf1f764e127176a3c6e4d20b3c3ba3` | closure: real portal execution, SessionVault/USDC signed paths, opt-in signing policy, fee audit, P note |
| `027ff5494ddb6f82fc4a078d1e2caaa771c4ebb9` | **final source**: finality adapter (fail closed) |

**Export for D** (`exports/`, sha256 in `exports/SHA256SUMS`):

| file | sha256 |
|---|---|
| `patches/0001…0004` (`git format-patch --root`) | `1bec1782…`, `c27e25c5…`, `ed67fcc1…`, `aa872a99…` |
| `rpc-transaction-independence-027ff549.bundle` (`git bundle verify` OK, head `027ff549`) | `d58726ef…` |

**Source file hashes at `027ff549`:**

| file | sha256 |
|---|---|
| `src/forced-inclusion.mjs` | `36680779…` |
| `src/vault-deposit.mjs` | `a0401e08…` |
| `src/lease-signing-policy.mjs` | `30cfd9e7…` |

## Test receipts

- **Final suite:** **26/26 pass** on exactly `027ff549` (`logs/closure-final-2.out`, one 512-MiB job, peak 251 MiB). It
  contains 7 test files: fee-audit 3, finality 1, forced-inclusion 6, l1-portal 5, lease-signing-policy 3, tracker 1,
  vault-deposit 7.
- **Mutation controls:** **27/27 killed, 0 survivors.**
  - The original 10 were re-run against the rewritten tests (`logs/mut-closure-1.out`).
  - 15 new closure guards (`logs/mut-closure-2.out`).
  - 2 finality guards (`logs/mut-closure-3.out`).
  - Mutants 1–15 ran before the finality function was appended to `forced-inclusion.mjs`. They target unchanged lines.
- **Earlier failed or superseded runs, kept as evidence:**
  - `fee-1`: the first GPO capture silently dropped rate-limited reads (a capture-tool bug). Fixed: any failed read now
    refuses the capture, and both chains were re-captured.
  - `fee-2`: expected `getL1FeeUpperBound(460)`, but the first deposit lease is charged 565 bytes. That is a real
    contract behaviour, documented below.
  - `vault-1`: a syntax error (`await` in a sync callback).
  - `vault-2`: a wrong expectation about the release recipient before a factory migration.
  - `mut-closure-1`: the harness separator collided with JavaScript `||`, so 3 mutants never applied. Fixed; a mutant
    that fails to apply now counts as a failure.
- **Scans:** `scan-crypto-keys.py --files` clean; `gitleaks` reported no leaks.

## 1. Real portal execution (replaces the synthetic L1 log)

**What was executed.**
- **Bytecode:** the PRODUCTION Base OptimismPortal bytecode on a local L1 (anvil 1.7.1, chain id 1, Prague). It was
  replayed at the captured block's own number and timestamp (`--number`/`--timestamp`), so the metering block distance is
  the real one.
- **Capture:** `tools/capture-state.mjs` → `evidence/capture/l1-portal.json` (sha256 `e05a48b2…`), from
  `https://ethereum-rpc.publicnode.com` at L1 block `0x1909a37` (hash `0x945e285a…`, 2026-10-23T07:51Z). It covers:
  - proxy `0x4904…e97e` (code `0x7d1cd19d…`);
  - EIP-1967 implementation `0x03863ab7f64b733cff85c8ff44a86601c568ca70` (code `0x007e6981…`, 19,458 bytes);
  - SystemConfig proxy `0x73a7…4072`, implementation `0x56ca4f4f…` (code `0x8f2f3085…`);
  - every slot the deposit path read (`eth_createAccessList`), plus the proxy's 64 low slots.

**Production vs fixture, explicitly:**
- **Real executed:** the bytecode one provider served, with `version()` = **6.0.1**. The replay reproduces that
  provider's `version()` and `params()` answers exactly.
- **Not proven:** deployed equivalence beyond that provider's answer. Every other public provider tried refused (drpc
  500, llamarpc 525, 1rpc usage limit), so there is **no cross-provider check**. This is research provenance, not
  verification.
- **Not the production configuration:** the replayed fixture's metering state (`params`) is the captured block's, and
  L1 base fees are chosen per test, with priority fee 0.
- **Labels:** the local L1 is `test-anvil-l1`, which no production default accepts. It is not an L1 light client.

**Measured on that bytecode** (`test/l1-portal.anvil.test.mjs`, `logs/closure-final-2.out`):
- **Aliasing:** an EOA deposits as itself. A contract wallet is ALIASED (+0x1111…1111). A 7702-delegated EOA called by
  a relayer is NOT aliased: 6.0.1 treats it as an EOA.
- **Hash derivation:** the real `TransactionDeposited` log → `matchDepositEvent` → viem `getL2TransactionHash` → the
  0x7E deposit the L2 executes, with the same hash.
- **L1 gas** (receipts, priority fee 0):

  | L1 base fee | 400k L2 limit | 800k L2 limit |
  |---|---|---|
  | 0.1 gwei | 435,082 gas | 834,921 gas |
  | 1 gwei | 435,069 gas = 4.35e14 wei | 834,921 / 832,256 gas ≈ 8.3e14 wei |
  | 5 gwei | 114,994 gas | 217,683 gas |
  | 30 gwei | 72,267 gas = 2.17e15 wei | 69,431 gas |

  Below about 5 gwei the resource-metering burn (L2 limit × the captured 1-gwei resource fee) dominates; above it, cost
  falls toward roughly 70k gas of execution.
- **Negative controls:**
  - gas below the portal floor reverts on L1, emits no log, and the tracker frees the slot only with that verified
    reverted receipt at the recorded L1 nonce;
  - a wrong implementation, version or portal is refused by `checkPortalPin`;
  - a look-alike log from another address is ignored;
  - the default verifier set refuses the anvil label;
  - a duplicate L1 send makes a second deposit, which fails on L2 (BadNonce) with no second effect;
  - a reverted deposit (forged signer, expired lease) changes nothing.
- **All earlier lease and direct tests** (forced-inclusion, 6) now go through this real portal. Two cases use real
  contract wallets to produce the aliased senders: the renew comes from a contract wallet's alias; the aliased-owner case
  has a contract at alice's own address on L1, and the REAL ledger refuses it as a failed deposit.

## 2. SessionVault and USDC signed paths (`src/vault-deposit.mjs`)

**Contracts are the existing compiled artifacts**, not rebuilt; metadata keccak equals the sources:
- SessionVault, SessionVaultLib and SessionVaultFactory: source keccak `0xa2a0324a…6ec8`, identical at `8ac1aa51c`,
  `7752a423`, app-lease-gas's "legacy" (production) copy, and the artifact's tree. The audit records that production's
  legacy vault runtime matches its historical source; its live runtime hash was not re-checked here.
- EnclaveAddressBook.
- The live ledger rev 16d.
- USDC is the repo's **MockUSDC3009 test mock** (FiatTokenV2_2's `receiveWithAuthorization` rules). The ERC-1271 owner
  is the repo's Mock1271Owner. Production USDC was not executed.

**Implemented** (every input read at one verified head; `readVaultSnapshot`, `readTokenSnapshot`):
- `planVaultOwnerOp`: topUp, extend, terminate, revokeAll, withdraw, adopt, setEnvironment, release.
- `planSessionCall`: execute and terminateBySession; P-256 via node:crypto over sha256(digest), exactly the vault's
  check.
- `planUsdcAuthorization`: `topUpWithAuthorization` (3009 nonce = the TopUp digest) and the ledger's
  `fundWithAuthorization` (`bytes16(nonce) == id`).

**Binding:**
- chain and domain `Enclave Sessions/1/8453/vault`;
- the vault is the pinned EIP-1167 clone from the pinned factory;
- the owner is a plain or 7702 EOA (a Safe or ERC-1271 owner is refused, not a fallback);
- single use: `opNonce` / lane sequence / `authorizationState`;
- expiry margins, session liveness, action bitmask (method permission), fee ≤ maxFee, amount within budget;
- the target deployment is held in an environment the grant allows;
- recipients: release only to the owner, or the owner's vault at the book's CURRENT factory;
- the 3009 payee is the contract itself, and the payer has no code.

**A hazard found in the real vault.** `_ownerAuth` and `_checkGrantAuth` return early when `msg.sender == owner`, so an
owner-equal sender **does not consume the opNonce**. Test 3 shows a deposit from the owner's own address plus the
ordinary L2 relay of the same signed withdraw **withdrawing twice**. Plans therefore refuse an L1 sender that is, or
aliases to, the owner (`sender-is-owner`).

**Tests** (7, real contracts):
- **TopUp** by deposit, then the same signature relayed on L2: NonceUsed, credited once.
- **Withdraw:** the ordinary L2 attempt first, then the deposit fails, so one effect. Plus the owner-sender hazard
  above.
- **Session `setActive`** via an aliased contract wallet: runs once. A replay, an unauthorized action (refund), an
  unauthorized target (an unheld deployment, which also reverts NotHeld on chain) and a wrong P-256 key are each refused.
- **Owner termination:** refunds the session escrow to the owner. Afterwards top-up and session calls are refused. Also
  refused: stale signBefore, wrong signer, high-s, an ERC-1271 owner, a non-clone vault, an unreviewed operation.
- **Release recipient:** with the same factory, the owner's vault is the vault itself and is refused. After the admin
  migrates the book to a new factory (an existing admin right, preserved), the owner's new vault is accepted. Others
  are refused.
- **3009:** top-up and ledger funding by deposit; replays refused by the planner and by the token; unbound nonce, wrong
  token domain and contract payer refused.

**Not implemented, and refused:** `open`/`openWithDeposit` (grant hashing), session `create`/`publish` (catalog, fee and
rate arguments not reviewed), arbitrary value calls, Safe owners, the first 7702 delegation.

## 3. Opt-in host signing policy (`src/lease-signing-policy.mjs`)

It is pure ESM on viem, so the same module serves Linux and Windows. The active Windows tree was not edited. It emits
the existing executor client's request shape (`{id, kind, enclaveId, nonce, deadline, maxChargeWei}` + payee) and its
EIP-712 typed data. It never signs and never changes configuration.

- **`relay` (default):** deadline = head + 300 s, unchanged. Passing forced options here is refused.
- **`l1-deposit`:** explicit opt-in naming the operation, the pinned portal, and an inclusion window between 900 s and
  (the sequencing window 43,200 s + 600 s). Rules:
  - `maxChargeWei` ≤ the owner's `maxPerOpWei`;
  - the reserve must report Ready;
  - release only where sponsored;
  - a second open authorization for the deployment is refused;
  - **renew is refused** when the owner's `renewWindow` (production: 300 s) or the lease time left is shorter than the
    window. The owner's configuration is untouched.
- **Continuity is reported as NOT guaranteed.** The protocol's worst case is 43,200 s, against the ledger's 1,800-s
  lease (real ledger value), so a withholding sequencer can let a lease lapse.
- **Tests** (3, real contracts with the production renewWindow 300): a forced claim's output, signed by a test key, is
  accepted by `planLeaseDeposit` and executed through the real portal and executor.

## 4. Fee audit: the app-funded requirement is NOT met by existing contracts

**Setup.** Base's PRODUCTION `GasPriceOracle` + `L1Block` were captured from `https://mainnet.base.org` at Base block
`0x3285829` (`evidence/capture/l2-gpo.json`, sha256 `2979b17b…`; single provider; GPO `version`/`isFjord`/`isIsthmus`
read). They were replayed behind the REAL `EnclaveLeaseGasReserve` at the calibrated `l1Bps` 10000. The replay
reproduces the provider's `getL1FeeUpperBound(460)` exactly.

**A forced claim, measured** (`test/fee-audit.anvil.test.mjs`, receipts):

| item | value |
|---|---|
| `LeaseGasPaid.gasPrice` | **0**: a deposit has no gas price, so the gas term is zero whatever the overheads, ceilings or caps |
| paid to the payee from the app's reserve (first lease) | **3,135,045,021 wei** = `getL1FeeUpperBound(565)` |
| later leases | 2,586,495,097 wei (460 bytes) |
| the L1 deposit, same transaction (1 gwei base fee) | 832,256 gas = **832,256,000,000,000 wei** |
| coverage | **3.8 × 10⁻⁶** |

- **Why 565 bytes on the first lease:** the executor's first lease always adds the 7702 authorization's 105 bytes, which
  a deposit cannot carry. This is a small, real overcharge (~5.5e8 wei), recorded rather than changed.
- **Every existing knob at its limit:**
  - gas and per-kind overheads (≤ 80,000) don't matter at price 0;
  - `l1Bps` > 10000 is refused by `setLimits` (real revert);
  - the authorization surcharge only adds bytes to the same bound;
  - the normal relay path does pay gas (comparison quote).
- **The one existing way app money can reach the L1 submitter:** the owner's own `reserve.withdraw(id, amount, to)`. It is
  manual and owner-authorized, not per operation, and not bound to any lease (tested).
- **Minimal unmet requirement** (no contract change proposed or made):
  - A per-operation, app-reserve-funded payment to the L1 submitter, bounded by the host's signed `maxChargeWei` and the
    owner's caps, sized to the L1 deposit cost.
  - It must be measured or bounded on L1, not by the L2 `tx.gasprice` and L1-data-fee formula that `finish()` uses.
  - The deployed reserve cannot express it: its charge is `gas × min(tx.gasprice, caps) + l1Bps × getL1FeeUpperBound`,
    and `tx.gasprice` is 0 for deposits.
  - Until a reviewed decision, **forced-inclusion leases are NOT app-funded**. Whoever submits the L1 transaction pays,
    unless the owner reimburses manually. This stays a final gate; it is not relaxed and not presented as solved.

## Finality (`classifyFinality`)

- `classifyL2Outcome` yields `unsafe` (a sequencer-signed head).
- `classifyFinality` upgrades only on named-verifier evidence about the right blocks:
  - L1 deposit-block finality from `l1-execution-proof` / `l1-light-client`;
  - `safe` / `finalized` only from `base-derivation` evidence for the receipt's own block number and hash;
  - `finalized` also requires the deposit's L1 block to be final.
- Evidence from the submission endpoint, mislabelled evidence or mismatched blocks is refused.
- With no evidence it stays `unsafe` and lists the gates. Nothing comes from a trusted boolean.
- **Not composed yet:** no derivation or light-client evidence source exists in this tree.

## Remaining gates (none satisfied here)

- **Funding:**
  - **L1 ETH** for every forced operation: about 4e14–2e15 wei per deposit at 0.1–30 gwei (table above).
  - **App-funded L1 reimbursement:** unmet (§4).
  - Hosts hold no ETH, and nothing assumes they do.
  - No relayer is funded automatically.
- **Signing:**
  - an L1 signer, outside every node, after root review;
  - the hosts adopting the opt-in policy (a client change Linux and Windows consume through the shared module);
  - an owner who wants forced renews widening `renewWindow` via the existing `configure`. The policy only refuses.
- **Hardware and L1:**
  - P's validated reth + Lighthouse pair, plus the opt-in local broadcast and verified reads/receipts/finality in
    `NOTE-FOR-P-L1-BROADCAST.md`;
  - S's holder for Base state, receipts and derivation evidence.
  - No public-RPC fallback anywhere. A refusal is an error, and resends keep the L1 nonce.
- **Consumer integration** (A, B):
  - Feed `readLeaseSnapshot`, `readVaultSnapshot`, `readTokenSnapshot` and `readSigningContext` from Helios's verified
    RPC (EIP-1898 pinned).
  - Receipts come from the verifier, not the submitter.
  - Deliver L1/derivation evidence into `matchDepositEvent` / `classifyFinality`.
  - No fresh proven roots exist yet, so nothing here is live-ready.
- **Production equivalence:**
  - Cross-check the portal 6.0.1 implementation `0x03863ab7…` and GPO captures against a validated L1/L2 source (P/S)
    or a second provider. That gives provenance; actual verification needs the validated pair.
  - Execute real FiatTokenV2_2.
