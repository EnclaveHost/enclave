# rpc-transaction-independence: Base transaction submission/inclusion when every public RPC refuses

2026-10-23. Source, research and offline tests only. Not done:
- no live chain writes, wallet use, funding or signing (except throwaway test keys inside anvil);
- no SSH, full sync, toolchain install, contract deploy or bind, or push.

One bounded read-only network probe was run through the queue: 4 GETs of primary OP Stack source from GitHub.
Author and committer are SteveDeFacto. Commit and test hashes are in [Evidence](#evidence).

## Answer

**There is one censorship-resistant submission path on Base for the pinned client: an L1 deposit through OptimismPortal.**
- The protocol must include a deposit within the sequencing window: 3600 L1 blocks, about 12 h.
- That keeps an operation's authorization intact only for two shapes:
  1. calls authorized by their own single-use signed payload; and
  2. calls from a plain EOA that signs a new L1 transaction itself.

**Enclave's most important routine operation fits shape 1:** the app-funded lease claim/renew/release through
`EnclaveLeaseExecutor`.
- I built a strict UNSIGNED plan/validation interface for it, and for four reviewed direct operations.
- Both were tested on the REAL compiled ledger rev 16d, registry, reserve and executor, executed as real 0x7E deposit
  transactions.

**What is not solved:**
- Inclusion beyond "unsafe": safe and finalized levels are not verified.
- Signing and funding the L1 transaction: it needs L1 ETH and an L1 signer.
- Getting L1 access without a public L1 RPC: that is S's L1 work.

There is **no safe generic fallback** for arbitrary user transactions, and none is offered.

## 1. The actual Base transaction path (base/base v1.5.1, `5476069f`, vendored copy)

| path | what the maintained source does | dependency it leaves |
|---|---|---|
| **Local Base execution node** (`base-reth-node`) | `eth_sendRawTransaction` is forwarded to `--rollup.sequencer-http` (Base's reference config: `https://mainnet-sequencer.base.org`, crates/execution/cli/src/lib.rs:186) and also kept in the local pool (crates/execution/rpc/src/eth/transaction.rs:86-100). The `tx-forwarding` crate forwards mempool txs to configured **builder RPC endpoints**. | Removes generic RPC *providers* only. It still depends on the Base-operated sequencer/builder endpoint, and it needs a full state holder (S c747's scope). |
| **Native P2P gossip** | `network_config.tx_gossip_disabled = true`, hard-coded (crates/execution/node/src/node.rs:1366). The consensus layer gossips blocks only. | **Not a submission path** for the pinned default client. This is not claimed for unknown custom operators. |
| **Direct sequencer endpoint** | HTTP to the one sequencer operator. | A single operator: it can refuse or be unreachable. A response is *acceptance*, not inclusion. |
| **L1 OptimismPortal deposit** | Portal `depositTransaction` emits `TransactionDeposited`. Base derivation decodes it (crates/consensus/protocol/src/deposits.rs, `from` taken from topic 1) into a type-0x7E transaction, which must be included within `seq_window_size: 3600` (crates/common/chains/src/config.rs:460, Base MAINNET; `deposit_contract_address` 0x4904…e97e = viem `base.contracts.portal[1]`). | L1 write and read access, L1 ETH, and a NEW L1 signature. |

**What a deposit changes**, from primary source:
- **Sender aliasing.** The L2 `from` is `msg.sender` when `EOA.isSenderEOA()` (`msg.sender == tx.origin`, or a 7702-delegated
  EOA in OptimismPortal2 **7.0.0**, develop). Otherwise it is `AddressAliasHelper.applyL1ToL2Alias(msg.sender)`
  (`+0x1111…1111`) (evidence/op-source).
  - Base's deployed portal version was not read. The `msg.sender == tx.origin` rule has existed since Bedrock; the
    7702 rule may not be live on Base.
- **Gas price and fees.** A deposit executes at gas price 0: `FromRecoveredTx<TxDeposit> for TxEnv` (`..Default::default()`,
  crates/common/consensus/src/transaction/deposit.rs:393) sets no gas price. It pays no beneficiary, L1 or operator fee
  (crates/common/evm/src/handler.rs `reward_beneficiary`).
- **Failure.** A failed deposit reverts everything except the sender's nonce bump and the mint (handler.rs `catch_error`).
- **Nonce.** It does not check the sender's L2 nonce.
- **No 7702 authorization list.** Type 0x7E cannot carry one.
- **Portal-side rules:**
  - gas floor = `21000 + 40 × data length`;
  - data at most 120000 bytes;
  - the L2 gas is bought on L1 as a burn of `gasLimit × prevBaseFee` (the resource market, initialized at 1 gwei,
    ResourceMetering.sol);
  - it reverts with `OutOfGas` when the 20M-per-block resource limit is exceeded;
  - deposits are not pause-gated (7.0.0).

**Anvil reproduces these semantics** (`tools/anvil-deposit-probe.mjs`, `logs/probe-1.out`):
- anvil 1.7.1 `--network optimism` executes viem-serialized 0x7E transactions;
- `GASPRICE` = 0, `CALLER` = `ORIGIN` = the deposit `from`;
- tx hash = keccak(serialization), which is what viem's `getL2TransactionHash` derives from the L1 log.

## 2. What each real Enclave operation needs (method coverage)

I read every contract named here, at checkpoint `8ac1aa51c` (and the live rev-16d ledger and schema-4 registry
sources). **No contract reads `tx.origin`.** Each operation is authorized either by its own signature (any submitter)
or by `msg.sender`.

| operation | authorized by | via L1 deposit | implemented / tested here |
|---|---|---|---|
| **lease claim / renew / release** through `EnclaveLeaseExecutor` (app-funded, operator already delegated) | operator's EIP-712 `Lease` (single-use executor nonce per deployment, deadline); the code runs AS the operator; the outer sender is never read | **YES, same signed Lease, same calldata.** Any funded L1 account submits. The ledger still sees the operator as `msg.sender`. The L2 tx type, `from` and nonce change but are irrelevant to authorization. **Duplicates:** a second copy reverts `BadNonce`. | **`planLeaseDeposit`.** Real-contract tests: claim from an EOA L1 sender, renew from an ALIASED (contract) L1 sender, a resubmitted copy fails, expired / forged / undelegated deposits fail. |
| renew within the production `renewWindow` (300 s) | same | **Refused by default.** A deposit's latency (L1 origin adoption, up to 12 h if withheld) does not fit a 300-s window. It needs the owner's existing `configure` with a longer `renewWindow` (≤ 1 day; an owner decision, no contract change), or a claim after the lease lapses (downtime). | `renew-window-too-short` / `NotInRenewWindow` refusals tested |
| a lease signed by today's host client | same | **Not usable as is.** `client/lease-executor-client.mjs` signs `deadline = head + ttlSec` with `ttlSec = 300`, while a deposit needs `deadline ≥ head + margin` (default 3600 s; ≥ 12 h + margin to survive a withholding sequencer). This needs a host-side signing policy (no contract change). Such a lease is an OUTSTANDING authorization until its nonce is consumed or its deadline passes. | `deadline-too-close` tested |
| first lease of a key (carries the EIP-7702 authorization) | 7702 authorization + Lease | **NO.** A deposit has no authorization list. | refusal `operator-not-delegated`; a deposit to an undelegated key "succeeds" with no effect, which `classifyL2Outcome` refuses (`receipt-mismatch`) |
| self-paid direct claim/renew by the operator key (pre-executor path) | `msg.sender` = operator | Would need L1 ETH **on the host key** (hosts hold none by design) | refused (`UNSUPPORTED`) |
| **admin / catalog**: `catalog.setApproval`, `catalog.setVerified` | `msg.sender == owner` | **Only if the owner is a plain (or 7702-delegated) EOA** that signs the L1 transaction itself and holds L1 ETH. A Safe or contract owner is ALIASED, so `!owner`. Duplicates: reviewed state setters, so a second execution leaves the same state (disclosed). | `planDirectDeposit` (planner-level). The live owner's code is checked at the verified head, not assumed. |
| other admin calls (`setMaxFee`, `transferOwnership`, `importApps`, `sealImports`, address book `set`, registry admin, reserve limits/pause/blocks) | `msg.sender == owner` | Same shape, but **not reviewed**. | refused (`unsupported-operation`) |
| **host changes** (registry `setPrices`/`setCaps`/`setProofKey`/`heartbeat`/`deregister`) | `msg.sender` = operator | Needs L1 ETH on the operator key | refused (`UNSUPPORTED`) |
| **`SessionVault.ownerCall`** | `msg.sender == owner`, DIRECT ONLY | Only for an EOA owner signing on L1. **Not a state setter**, so it is refused while any L2-signed attempt for it could still land (deposits skip the nonce check). | `planDirectDeposit` (planner-level; no SessionVault artifact compiled here) |
| SessionVault owner-SIGNED ops (`topUp`, `extend`, `terminate`, `revokeAll`, `withdraw`, `promote`, `adopt`, `setEnvironment`, `release`) and session-key `execute` / `terminateBySession` | EIP-712 / ERC-1271 signature + single-use `opNonce` / lane nonce + `signBefore` / deadline | **Compatible by source reading** (sender-agnostic, single-use), including Safe owners via ERC-1271 | **not implemented** (next step: the lease pattern) |
| ledger owner direct ops: `setActive` | `d.owner == msg.sender` | EOA owner on L1 | **`planDirectDeposit`, REAL ledger test**: works from the owner; from the owner's alias the real ledger refuses (failed deposit, state unchanged) |
| other ledger owner ops (`setConfig`, `setShares`, `setMaxRate`, `refund`, `transferDeployment`), `create`, `fund`, `fundEth` (value) | `msg.sender`; value | Value needs a mint and an L2 balance model; not reviewed | refused |
| ordinary user transactions (arbitrary contracts) | per contract | **No generic fallback.** The original Base signature cannot be carried; sender, nonce and fee semantics change. | refused |
| host registration (ERC-4337 `handleOps` with the host paymaster) | EntryPoint rules | EntryPoint behaviour under a deposit not reviewed | refused |

**No contract change is needed or proposed.** Every supported row uses deployed functions with their existing
authorization.

## 3. What was built (`src/forced-inclusion.mjs`)

Everything is built from maintained primitives. viem 2.53.1 provides EIP-712 recovery, ABI encoding, the deposit
serializer and the source hash, `extractTransactionDepositedLogs`, `opaqueDataToDepositData` and
`getL2TransactionHash`. Two portal facts are pinned instead:
- the portal ABI, by its exact signature: viem does not export its internal copy publicly, so tests check it against
  the fetched OptimismPortal2 source and against viem's internal ABI file;
- the alias, as the documented `+0x1111…1111 (mod 2^160)` offset, checked against AddressAliasHelper.sol.

There is no hand-rolled cryptography and no signing or sending code.

**`planLeaseDeposit`** produces an unsigned L1 request `{chainId: 1, from, to: portal, value: 0, data}`. Its plan binds:
- the chain, portal, executor, reserve and ledger;
- the operator and the whole Lease (id, kind, enclave, nonce, deadline, payee, max charge);
- the verified head.

It refuses on any of:
- a pin mismatch: the executor↔reserve↔ledger binding and the delegation code hash are re-read at the head;
- an operator that is not delegated;
- a bad or high-s signature, or a signer that is not the operator;
- a stale nonce;
- a deadline under the margin;
- reserve status not `Ready`;
- too little renew headroom;
- non-canonical calldata (388 bytes);
- gas outside [portal floor, reviewed min/max];
- a stale or unverified head;
- an ambiguous duplicate.

The plan also discloses the authorization, the funding and the duplicate semantics.

**`readLeaseSnapshot`** reads every input pinned to ONE block hash (EIP-1898) through a VERIFYING client. In
production that is Helios's RPC, or P's witness gateway behind it, so every `eth_call` is checked against that head's
state root.

**`planDirectDeposit`** handles the reviewed `msg.sender` operations only (`REVIEWED_DIRECT`). It requires:
- `from` equals the address the contract authorizes, read at the head;
- that address has no code, or only a 7702 designator;
- the calldata decodes to the reviewed function (`ownerCall` refuses `multicall`).

It refuses while an L2-signed attempt could still land:
- `accountNonce ≤ attempt.nonce` at the verified head, unless the operation is a reviewed state setter (then this is
  disclosed);
- also refused when an earlier attempt is already included.

**`ForcedInclusionTracker`** is the durable duplicate guard. Its rules:
- one open commitment per key;
- the same commitment is a replay, never a new send;
- an L1 resend must reuse the recorded L1 nonce (`checkL1Send`);
- a slot frees only on verified evidence: `resolveExpiredLease` needs a verified head past the deadline with the nonce
  unconsumed, and `resolveFailedL1` needs a verified reverted L1 receipt at the recorded nonce;
- states never regress.

**`matchDepositEvent`** requires an L1 receipt that an L1 verifier bound (`l1-light-client` or `l1-execution-proof`,
same block hash). It needs exactly one portal log matching to, version, mint, value, gas, isCreation, data and an
acceptable `from`. For direct operations the only acceptable `from` is the owner, never its alias. It returns the
derived L2 transaction hash.

**`classifyL2Outcome`** accepts a receipt only from the local verifier (Helios; tests pass `verifiers:['test-anvil']`,
labelled). It refuses:
- a data endpoint equal to the submission endpoint;
- a stale head;
- a receipt above the verified head;
- the wrong tx hash or type.

For leases it requires exactly one `LeaseGasPaid(id, operator, payee, kind)` from the reserve. It returns
`l2-included`, `l2-failed` or `pending`, at level **`unsafe`**.

**Receipt verification is reused, not duplicated.** Helios `core/src/execution/providers/rpc.rs::get_receipt` fetches
the block's receipts and checks them with `verify_authenticated_block_receipts`: the receipts root against the
authenticated block, plus count and cumulative gas. P's gateway and witness-check stay untouched.

## 4. Tests and controls

Real: the compiled live ledger rev 16d, registry schema 4, `EnclaveLeaseGasReserve` and `EnclaveLeaseExecutor`
(metadata keccak = `fixtures/sources`; artifacts from `work/app-lease-gas/forge/out`, not rebuilt), real 7702
delegation, real 0x7E deposits, and real EIP-712 signatures with test keys.

Fixture or label:
- the L1 `TransactionDeposited` log is built per the portal source; no L1 portal is executed, and the L1 block hash is
  synthetic;
- the "verified head" is anvil's latest block;
- the "verifier" is labelled `test-anvil`;
- USDC and the feed are the repo's mocks;
- `l1Bps` is 0, and there is no GasPriceOracle on anvil.

**Suite** (`jobs/run.sh test/forced-inclusion.anvil.test.mjs test/tracker.test.mjs`): **7/7** on commit `a460c36c` (`logs/suite-final-3.out`;
one 512-MiB job with the mutants, peak 202 MiB, `logs/final-3.guard.log`).
1. **Provenance**:
   - artifacts compiled from the pinned sources;
   - the portal `depositTransaction` signature, gas floor, aliasing branch and alias constant all match the fetched
     OP source;
   - the event selector is Base's `EVENT_ABI_HASH`.
2. **CLAIM by deposit**:
   - the ledger's `runnerOperator` is the operator;
   - `LeaseGasPaid.gasPrice` = 0 and charged 0, so the app paid no L2 gas;
   - gas used 334,193 of an 800,000 limit;
   - the same plan executed again **fails** (BadNonce), the executor nonce stays 1, and a re-plan is refused.
3. **RENEW from an aliased L1 sender**:
   - works, and the tx `from` is the alias;
   - too early is refused (`NotInRenewWindow`), and 550 s of headroom is refused under the default 600-s policy.
4. **Negative controls**:
   - a forged signer is refused by the planner, and on chain the forged deposit fails with the nonce untouched;
   - also refused: high-s, a consumed nonce, too short a deadline, a stale head, a pin mismatch and an unverified head;
   - an undelegated key: the planner refuses it; on chain the deposit "succeeds" doing nothing, and the outcome check
     refuses that;
   - tracker replay vs. ambiguous duplicate;
   - expiry frees the slot only after a verified head passes the deadline, and an expired lease fails on chain.
5. **DIRECT `ledger.setActive`**:
   - from the owner it works;
   - from the owner's alias the REAL ledger refuses (failed deposit, still active), and the matcher refuses an aliased
     log;
   - refused: an unreviewed op, a sender mismatch, a contract owner, wrong calldata, an ambiguous `ownerCall`, an
     already-included attempt and gas below the floor;
   - a state setter with a pending attempt is disclosed.
6. **Outcome and L1-log checks fail closed**: unverified receipt, same endpoint, stale head, receipt above the head,
   pending, unverified L1 proof, header mismatch, two matching logs, and a different gas limit.
7. **Tracker unit tests**: L1-nonce discipline, failed-L1 resolution, expiry, no regression, JSON round-trip.

**Mutation controls** (`jobs/mutants.sh`): **10/10 killed**, 0 survivors (`logs/final-3.out`). Each mutant removes one
guard:
1. the signer check;
2. the nonce check;
3. the contract-owner check;
4. the endpoint-independence check;
5. owner-only `from`;
6. the delegation check;
7. the `LeaseGasPaid` check;
8. the replay rule;
9. the L1-nonce rule;
10. failed-L1 verification.

The nonce mutant survived the first run (the "plan again" assertion also accepted `LeaseLive`). An explicit
stale-nonce control fixed that.

Scans: `scan-crypto-keys.py --files` clean, `gitleaks dir` reported no leaks. Test keys are generated per run, with no
literals.

## 5. Inclusion levels: what is verified, and what is not yet

| level | meaning | how | here |
|---|---|---|---|
| L1 accepted | the portal tx is in an L1 block | L1 receipt verified against an L1 header (Helios ethereum mode: beacon sync-committee light client + receipts root) | `matchDepositEvent` takes the verified receipt; the **L1 verifier is not composed** (S's L1 follow) |
| L1 final | that L1 block is finalized (about 2 epochs) | same light client | not composed. Once final, **L2 inclusion is guaranteed by the protocol** within the sequencing window, but the L2 *outcome* is not known until execution. |
| L2 unsafe | receipt in a block under a **sequencer-signed** head | Helios opstack + `verify_authenticated_block_receipts`; heads from the gossip listener | **`classifyL2Outcome`** (level `unsafe`) |
| L2 safe / finalized | the L2 block derived from L1 batch data / that data final | a derivation node, or an L2 output root from the L1 `DisputeGameFactory` (0x43ed…40e) / AnchorStateRegistry read through a verified L1 `eth_call`, plus the output-root preimage (version, state root, message-passer root, block hash) linked by ancestry (P's ancestry) to the receipt's block | **not implemented**. A resolved dispute game takes days, so the practical finality signal is a derivation node (S). |

**Never retry blindly.** A deposit on L1 WILL execute. An acceptance from the sequencer endpoint, followed by
uncertainty, is not grounds for a deposit, except:
- for the lease shape, where the nonce makes the second copy fail; or
- after the earlier attempt is provably resolved (included, failed, or dead).

## 6. L1 needs (S owns the node and L1-follow plan; this is the exact list)

- **L1 WRITE.** Broadcast ONE signed type-2 transaction to the portal.
  - Any L1 execution endpoint works: the transaction is self-authenticating, so a censoring endpoint only delays it.
  - Ethereum L1 *does* gossip transactions (eth/68), so a peer-to-peer broadcaster on S's L1 execution client is a real
    non-RPC path. Reaching peers needs devp2p/discv5 dialling, which was not authorized or probed here.
  - Fee bumps and resends must keep the recorded L1 nonce (`checkL1Send`).
- **L1 READ, verified.**
  - L1 headers come from a light client (Helios ethereum mode: a weak-subjectivity checkpoint plus light-client updates
    from a beacon API or node).
  - The deposit's L1 receipt needs `eth_getBlockReceipts` data, verified against the receipts root.
  - The L1 sender's nonce and fee data are needed for signing.
  - Portal facts at a verified L1 head, before activation:
    - `version()` (aliasing for 7702 senders);
    - SystemConfig `resourceConfig` (`maxResourceLimit`, `minimumBaseFee`);
    - portal `params()` (`prevBaseFee`, which gives the burn).
- **L2 READ, verified.** The planning snapshot and the receipt need a fresh Base head (gossip listener → P's root store
  → Helios) plus state/receipt data. That data source is the same availability gap the state holder closes (S c747);
  this module only verifies.

## 7. Signing and funding, only where proved necessary (no wallet request made)

- **Lease by deposit:**
  - **The host:** signs ONE EIP-712 Lease with a deadline ≥ the chosen inclusion bound. This needs a host-client policy;
    today's `ttlSec = 300` does not fit. No ETH.
  - **An L1 account** (any; a root-designated relay or the app owner) signs ONE L1 type-2 transaction to the portal and
    pays:
    - the L1 execution gas of `depositTransaction`, not measured here: needs a real portal on an L1 fork;
    - plus the resource burn, `gasLimit × prevBaseFee`: 500k × 1 gwei = 0.0005 ETH at the portal's minimum resource fee.
  - **The app's reserve:** pays nothing for L2 gas (gas price 0). With the calibrated `l1Bps = 10000`
    (app-lease-gas fixture, not read live), it pays the payee only `GasPriceOracle.getL1FeeUpperBound(460)`.
  - **Gap:** the L1 sender is **not reimbursed on L1** by any existing contract. Keeping it app-funded would need an
    off-chain settlement from that L2 payee payment, which is bounded by `maxChargeWei` and the owner's caps. That is a
    business/policy decision, not a contract change.
- **Admin / owner direct operations:** the owner key itself signs an L1 transaction and holds L1 ETH. A Safe or contract
  owner cannot use this path.
- **The owner's `renewWindow`:** if renew-by-deposit is wanted, it must exceed the inclusion latency, set via the existing
  `configure` (owner-signed). Otherwise use claim-after-lapse.

## 8. Remaining work, precisely

1. **Compose the verifiers.** Wire `readLeaseSnapshot` and the receipt read to Helios's RPC on S's head and state
   source (B or root). Add the L1 light client for `matchDepositEvent` and `resolveFailedL1` (S's L1 follow).
2. **L1 portal execution test.** Real OptimismPortal2 bytecode on an L1 anvil fork, or the deployed Base portal at a
   pinned L1 block, plus a read of `version()`. This replaces the L1 log fixture and measures L1 gas.
3. **Signed-owner SessionVault operations and USDC authorizations.** They follow the lease pattern (sender-agnostic,
   single-use nonce) and still need an implementation plus real-artifact tests. A SessionVault artifact build fits
   under 1536 MiB only if built alone; not attempted.
4. **Host-client policy** for long-deadline forced-inclusion leases (who may hold them; claim/renew only).
5. **Safe/finalized classification** via the derivation node or dispute games (§5).
6. **Root review before any live wallet or L1 action.**

## Evidence

- **Code commit `a460c36c88f41b95e6c2c8f27f7083a4415917c7`** (SteveDeFacto). The final test run is on exactly this
  tree: `src/forced-inclusion.mjs` `b2552fd5…`, `test/forced-inclusion.anvil.test.mjs` `cbd5de83…`,
  `test/tracker.test.mjs` `784ba86d…`. The follow-up commit adds only this file's evidence lines and logs.
- Earlier runs, kept as evidence:
  - `anvil-1`, `anvil-2`: failed on test-setup bugs. `renewWindow` 1800 made "too early" impossible; then an address-case
    comparison, and an older head passed to the outcome check.
  - `mutants-1`: the nonce mutant survived.
  - `final-2`: never admitted by the queue (exit 98).
- Sources (read as Git objects):
  - checkpoint `8ac1aa51c36ec4e8a1fa3d5a60c0438a721190ab` (main-repo `checkpoint/decentralization-20261022`);
  - published main `7752a4239b3bec2cf452491cd1b95164a8c2bdb8` (its ledger source is newer than the live rev 16d);
  - base/base `5476069f`;
  - Helios `aca81764` (P's).
- OP source (`evidence/op-source`, develop, fetched 2026-10-23T05:03Z, `logs/fetch-op-1.out`):

  | file | sha256 |
  |---|---|
  | OptimismPortal2.sol | `47b8ded7…` |
  | EOA.sol | `65c83beb…` |
  | AddressAliasHelper.sol | `5e50ac37…` |
  | ResourceMetering.sol | `97411c4d…` |

- Artifacts and sources: `fixtures/` (sha256 printed by every run).
