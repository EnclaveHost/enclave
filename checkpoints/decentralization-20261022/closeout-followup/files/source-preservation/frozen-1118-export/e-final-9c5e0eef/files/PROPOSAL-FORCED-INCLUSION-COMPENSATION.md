# App funding for FORCED (L1-deposit) lease operations: decision record and minimal compatibility proposal

**Status:** PROPOSAL ONLY.
- No contract was written, deployed or bound. No funding or withdrawal was automated.
- No existing contract or balance is touched. Root owns the decision.

## Three costs that must not be conflated

| cost | when | who pays today | status |
|---|---|---|---|
| **Routine Base broadcast fee** | the normal relay path: the host's signed Lease in a type-2/4 L2 transaction via the sequencer/builders | the app's `EnclaveLeaseGasReserve`: `finish()` pays the relay `gas × min(tx.gasprice, owner cap, admin ceiling) + l1Bps × getL1FeeUpperBound` | **app-funded, works** (fee audit "normal relay" quote > 0) |
| **Emergency forced-inclusion L1 fee** | every public RPC and the sequencer refuse, so the same Lease goes in through OptimismPortal on L1 | whoever signs the L1 transaction: about 4e14–2e15 wei per deposit (measured on production portal 6.0.1 bytecode) | **NOT app-funded.** The reserve paid 3.1e9 wei against 8.3e14 wei of L1 cost (coverage 3.8e-6); a deposit has `tx.gasprice` 0 |
| **Lease continuity delay** | a withholding sequencer delays a deposit up to the sequencing window (43,200 s) | nobody pays; the app is DOWN past its 1,800-s lease | protocol bound. Forced renew is refused under the production renewWindow 300; claim after lapse |

## What the existing deployed contracts allow (inspected, and tested where marked)

- **`EnclaveLeaseGasReserve`** (source `1d173473…`, the artifact tested here):
  - It pays only in `finish()`, using the formula above. At gas price 0 only the L1-data-bound term remains, capped by
    `l1Bps ≤ 10000`; `setLimits(l1Bps 10001)` reverts (tested).
  - `withdraw(id, amount, to)` is keyed to `msg.sender` (`budgetKey(id, msg.sender)`), and it is refused inside a lease
    operation (`_tload(T_ID) == 0`).
  - There is no allowance, delegate or module path. Nobody but the owner of record can move reserve ETH to an
    arbitrary payee.
- **Owner of record = an EOA:** each `withdraw` is that owner's own L2 transaction (tested: the owner's withdraw to an
  arbitrary address works). That means one owner signature per transfer, not per lease.
- **Owner of record = a SessionVault:**
  - The reserve's owner of record is the vault. `withdraw` is reachable only through `vault.ownerCall(reserve, …)`,
    which is DIRECT ONLY (`msg.sender == owner`, never signable).
  - Session keys have no reserve action: the action table stops at `app.publish` (`ACT_LAST = 8`).
  - Owner-signed operations (`topUp`/`withdraw`/…) move the vault's USDC, not the reserve's ETH.
  - So no automation is possible without the owner's direct transaction each time.
- **Ledger:** `fundEth` / `fundWithAuthorization` fund COMPUTE in, and nothing pays out to a submitter.

**The one existing, bounded, owner-authorized workaround:** the owner prepays a FLOAT. It is one `reserve.withdraw` of a
bounded amount to a designated L1 submitter's L2 address, made before any emergency. It has these properties:
- one owner signature per float, not per operation;
- the submitter must be TRUSTED: it can keep the float without ever submitting;
- it is paid in L2 ETH, while the submitter needs L1 ETH up front. L2 ETH is not L1 liquidity: returning it to L1 takes
  a Base withdrawal (prove + finalize; about 7 days under fault proofs) or a third-party bridge, with that bridge's trust
  and fees.

This keeps the cost app-paid economically, but it is manual, trust-based and liquidity-bound. It is not an automated
app-funded forced lease.

## Decision

The existing contracts **cannot** pay forced-inclusion L1 costs automatically from the app's reserve without one of:
- a host fronting ETH;
- an owner signature per transfer;
- a trusted float.

The **exact unmet requirement:**

> A per-operation payment from the app's own escrow to the L1 submitter, executed atomically with the forced lease
> itself, bounded by (a) the host's signed maximum, (b) the owner's per-operation and per-epoch caps, and (c) an on-L2
> estimate of the L1 cost from the L1 base fee Base itself exposes (L1Block predeploy), and paid only if the lease
> operation succeeds. The current reserve cannot express this: its charge is a function of `tx.gasprice`, which is 0
> for every deposit.

## Minimal compatibility proposal (additive; nothing existing changes)

One NEW, optional contract, `EnclaveForcedLeaseCompensator`:
- It sits beside the existing ledger, registry, reserve and executor, unchanged.
- An app opts in only by funding it.
- No migration, no re-delegation, no change to any balance or admin right.

**Interface sketch** (a specification, not an implementation):

```solidity
interface IEnclaveForcedLeaseCompensator {
    struct Policy { bool enabled; uint64 maxPerOpWei; uint64 epochCapWei; uint32 epochSec;
                    uint32 l1GasAllowance;   // L1 execution gas of depositTransaction the owner agrees to repay (~70k-120k)
                    uint64 maxL1BaseFeeWei; uint64 resourceFeeWei;  // caps on the L1 price inputs, owner-set
                    address submitter; }     // 0 = any submitter the host names in ForcedTerms
    struct ForcedTerms { bytes32 leaseDigest; address submitter; uint256 maxCompensationWei; uint64 deadline; }
    // owner of record (EOA directly; a SessionVault through ownerCall); anyone may deposit (a gift to that owner)
    function deposit(bytes32 id) external payable;
    function configure(bytes32 id, Policy calldata p) external;
    function withdraw(bytes32 id, uint256 amountWei, address payable to) external;   // the owner's own escrow only
    // called BY the L1 deposit: runs the existing executor's lease, then pays the submitter, atomically
    function forcedLease(address operator, EnclaveLeaseExecutor.Lease calldata l, bytes calldata leaseSig,
                         ForcedTerms calldata t, bytes calldata termsSig) external;
    // admin (Enclave): pause, block a deployment/operator, global ceilings; NO path to any escrow
    function setPaused(bool) external; function setBlocked(bytes32 id, bool) external; function setCeilings(uint64 maxPerOpWei, uint64 maxL1BaseFeeWei) external;
}
```

**Rules `forcedLease` enforces:**
1. `tx.gasprice == 0`. On Base only deposits run at price 0, so this is deposit-only. That assumption must be reviewed
   per fork.
2. `termsSig` is the OPERATOR's EIP-712 signature over `ForcedTerms`, so the payout is bound to this lease and this
   submitter. It uses the host's existing key, off-chain, with no ETH.
3. `tx.origin` is `t.submitter` or its L1→L2 alias, so only the named submitter's own deposit is paid.
4. It calls `operator.lease(l, leaseSig)` with the exact canonical encoding. The existing executor and reserve run
   unchanged; any revert reverts everything, and nothing is paid.
5. It pays `min(t.maxCompensationWei, policy.maxPerOpWei, epoch left, escrow,
   (l1GasAllowance + l2GasLimit × resourceFeeWei / max(L1Block.basefee, 1 gwei)) × min(L1Block.basefee, maxL1BaseFeeWei))`
   to `t.submitter` on L2.
   - This mirrors the portal's own metering formula, with owner-capped inputs. It is an estimate, not a measurement of
     the L1 receipt.

**Unsigned call and permission inventory** (who would authorize what; nothing here is requested now):

| step | call | authorized by | chain | funding |
|---|---|---|---|---|
| 1 | deploy `EnclaveForcedLeaseCompensator(ledger, registry)` | Enclave admin, after root and security review | Base | admin L2 gas |
| 2 | `configure(id, policy)` | the deployment's owner of record: EOA direct, or `vault.ownerCall(compensator, configure)` | Base | owner L2 gas (routine) |
| 3 | `deposit(id)` | anyone (credited to the owner of record) | Base | the app's ETH. A separate escrow: reserve balances are NOT moved automatically. The owner may move them by its own `reserve.withdraw` → `deposit` |
| 4 | sign `Lease` + `ForcedTerms` | host operator key, off-chain, under the opt-in policy (`src/lease-signing-policy.mjs`) | none | none |
| 5 | `portal.depositTransaction(compensator, 0, gasLimit, false, forcedLease(...))` | the L1 submitter (any funded L1 EOA), via P's opt-in local broadcast | Ethereum | **L1 ETH fronted by the submitter**, repaid in L2 ETH on success |
| 6 | `withdraw(id, amount, to)` | owner of record | Base | none |

**Remaining trust, cost and race requirements, even with the proposal:**
- **Liquidity.** The submitter fronts L1 ETH and is repaid in L2 ETH. Returning value to L1 takes about 7 days via the
  canonical bridge, or a third party. Someone must hold an L1 float sized to the expected number of forced operations ×
  about 1e15 wei.
- **Races.** Anyone can submit the same signed Lease directly (sequencer or another deposit). If theirs lands first, the
  named submitter's deposit reverts as a whole (BadNonce), so it is not paid and its L1 cost is lost. That is bounded per
  operation and should be disclosed. Resend rules are unchanged: same L1 nonce only; the tracker owns them.
- **Estimate.** The L1 cost is an on-L2 estimate (L1Block base fee, owner-capped allowances), not the L1 receipt.
  Owners set the caps.
- **Continuity.** Payment does not shorten the protocol delay; the lease may still lapse (see the table above).
- **Admin.** Enclave keeps pause, block and ceilings, and has no path to any escrow, matching the reserve's admin model.
  Owner admin migration is unaffected: escrows stay keyed to the owner of record.
