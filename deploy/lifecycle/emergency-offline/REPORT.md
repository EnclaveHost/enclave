# Emergency app-offline: protocol delta, candidate and tests

**Status: source-only staging prototype. Nothing was compiled or tested by the author.
Not build-qualified, not deployable, no financial permissions, no new
contract address authorized.** Paired-ledger production integration is **BLOCKED**
(see section 7). **Root follow-up:** the corrected prototype now compiles and
passes 32 tests (18 distinct scenarios), with a 17,253-byte runtime. Root
reproduced and fixed the Queue reserve bug; see `ROOT-REVIEW.md` and
`root-validation/`. The first small-cap compile was safely stopped and remains
recorded. Actual-ledger, full Base reimbursement and live integration remain
unqualified.

Baseline: `EnclaveHost/enclave` lifecycle candidate commit
`ecf364c0a81b9176163d254dcfc9685572bde0cd`, read-only at
`.../work/enclave-deployment-lifecycle` (`contracts/EnclaveDeploymentLifecycle.sol`,
`deploy/lifecycle/EnclaveDeployments.sol`, `contracts/EnclaveSelfHostingIdentity.sol`,
`test/lifecycle/forge/test/Lifecycle.t.sol`). Builds on `BASELINE-AUDIT.md`.

## 1. Files

| Path | Purpose |
| --- | --- |
| `candidate/contracts/EnclaveDeploymentLifecycleEmergency.sol` | Modified controller (baseline + delta). Also defines the `ILifecycleLedgerV3` port and the `LifecycleSettlementAck` encoding. |
| `candidate/test/mocks/EmergencyMocks.sol` | Adversarial mocks: `MockPairedLedger` (a test-only reference model of the proposed schema-3 gates, with knobs for down, revert, settle-at-now and wrong-generation acks), plus `MockIdentity`, `MockL1Oracle` and `RejectingRelay`. |
| `candidate/test/LifecycleEmergency.t.sol` | 14 Foundry tests (section 8). |
| `foundry.toml` | Minimal config. forge-std comes from baseline `contracts/foundry/lib/forge-std/src/`, read-only. |

Run (root, after review), from this directory: `forge test --threads 1 -vv`. The
baseline lifecycle script uses `FOUNDRY_OPTIMIZER_RUNS=1`/`prague`; this config pins the same.

## 2. Why a separate entrypoint

In the baseline, `transition` is the only way to revoke a run, and it fails if any of these fail:

- the live `ledger.lifecycleOwner` read
- the `ownerAuthority` identity lookup (evaluated before the quorum fallback)
- ERC-1271 `staticcall`s
- the synchronous `ledger.lifecycleEnd`
- the fee cap, gas-price and reserve admission checks
- the L1 oracle
- the push refund to the payee

Weakening `transition` would change every path. The candidate leaves `transition`
semantically unchanged, apart from the schema-3 ledger calls and the pending gate. It adds:

- `emergencyOffline(Emergency, bytes[] approvals)`: a durable, authenticated record. It makes **zero external calls**. `ecrecover` is a precompile; everything else is local storage.
- `reconcileOffline(id)`: permissionless. It completes the settlement against the paired ledger at the **stored** cutoff.
- `claimReimbursement(to)`: a pull payment of the bounded execution-gas debt.

## 3. Exact transitions

The EIP-712 domain is `EIP712Domain(name="EnclaveDeploymentLifecycle.EmergencyOffline", version="1", chainId, verifyingContract=this)`.
The type is `EmergencyOffline(bytes32 id,uint64 generation,uint64 revision,uint8 fromState,bytes32 host,address operator,uint8 target,uint64 deadline,address payee,uint128 maxReimburseWei)`.
Both the domain name and the type differ from `Transition`, so approvals cannot cross between the two paths.

**E1 `emergencyOffline`.** Checks are applied in this order:

1. `h == lastEmergency[id]`: return `false`. No state change, no charge (exact-intent retry).
2. `a.owner != 0 && threshold[id] != 0`. An unknown id or a zero threshold never authorizes.
3. `fromState == Running && a.state == Running`.
4. `generation == a.generation && revision == a.revision && host == a.host && operator == a.operator`. This binds the exact current run.
5. `target ∈ {Queued, Stopped}`. Revocation only: never Running, never a resume.
6. `now <= deadline <= now + 120`.
7. `payee == 0 ⇒ maxReimburseWei == 0`, else `payee == msg.sender`.
8. `maxReimburseWei <= budget.maxTransitionWei`.
9. `_quorum`: strictly ascending EOA signers, each in the configured set, count in `[threshold, |set|]`, low-s, `v ∈ {27,28}`.

Effects:

- `offline[id] = {runGeneration: a.generation, cutoff: block.timestamp, stopped, pending: true, host, operator}`.
- `startAfter = max(startAfter, now + FENCE_SEC)`.
- If the target is Queued, the baseline failure backoff and crash-hold apply. There is no healthy reset on this path.
- `state = target`, host and operator are cleared, `changedAt = now`, `++generation`, `lastEmergency[id] = h`.
- If there is a payee, the bounded execution-gas estimate moves from `balanceWei` to `reimbursable[payee]`. It is capped by the signed maximum and available reimbursement funds. For Queued, available funds exclude `stopReserveWei + 1`; for Stopped they may include the protected reserve. Zero availability reduces reimbursement to zero without blocking the record. `reimbursements[h]` records the remaining signed cap as unpriced L1 capacity and the calldata size. The overhead formula is an estimate, not exact receipt-derived cost.

**E2 `reconcileOffline`.** If nothing is pending, it returns `false`. Otherwise:

- It calls `ledger.lifecycleEndAt(id, runGeneration, host, operator, cutoff, stopped)`.
- It requires the return value to equal `LifecycleSettlementAck.hash(ledger, controller, chainid, id, runGeneration, host, operator, cutoff, stopped)`.
- Only then does it set `pending = false`.

Any revert or ack mismatch leaves the record pending.

**Gates while `pending`:**

- `transition` (all targets), `resume`, `configure`, `setAuthorityPolicy` and `withdraw` revert with `offline settlement pending`.
- `canTransfer` is false, so ledger `transferDeployment` refuses.
- `funded` is false.
- `deposit` is still allowed (it only adds).

**Normal path change.** From Running, the normal path now calls `lifecycleEndAt` with `cutoff = block.timestamp` and checks the ack. Starts pass `runGeneration = a.generation + 1` to `lifecycleStart`, so the ledger knows which controller generation each run belongs to. Idle stop still uses `lifecycleEnd(id, true)`. On a ledger that has a runner, that call must refuse.

## 4. Invariants

- **I1 Authentication.** The record requires a valid >2/3 quorum of the owner-configured set, over this chain and this controller, for the current `(generation, revision, host, operator)`. Duplicate, unsorted, outsider, high-s, wrong-domain, wrong-chain, Transition-typed and sub-threshold approvals fail.
- **I2 No new authority.** The baseline quorum can already queue or stop a Running assignment through `transition`. The emergency path gives that same set no new power and strictly less scope: it cannot start a run, resume, or reset the failure count.
- **I3 Durability.** The record depends on no external contract. Ledger, identity, oracle, token and payee failures cannot roll it back. Admission policy (gas price, reserve, balance) limits only the reimbursement.
- **I4 Replay.** One commit per generation (`++generation`). An exact retry is a no-op that returns `false` and never charges. Any differing intent for the consumed generation fails (`not running` or `stale assignment`).
- **I5 Revocation only.** The target is never Running. A crash-hold still needs the owner's `resume`. The fence and backoff can only extend.
- **I6 Pending isolation.** While pending, nothing can create a new run, change policy, move ownership or withdraw the budget, and `funded()` is false.
- **I7 ETH conservation.** `address(this).balance == Σ balanceWei + Σ reimbursable` (asserted in tests). Reimbursement moves money between those two buckets and creates none.
- **I8 Settlement binding.** A record clears only on an ack for exactly the stored run and cutoff. `reconcileOffline` succeeds at most once per record, and `endAtCalls == 1` across retries.
- **I9 Bounded cost estimate.** The execution component uses measured execution plus a fixed overhead/calldata estimate and capped `tx.gasprice`. It is not a qualified actual Base receipt cost. The L1 data component is **recorded unpriced**. It is neither reserved nor claimable, and no caller-supplied receipt is accepted.

## 5. Authority: owner, quorum, vaults

The owner keeps the existing normal stop: `transition` signed by `ownerAuthority`, which may be an ERC-1271 vault principal. That path still needs the ledger, identity and oracle to be live.

**I did not implement a stored owner-emergency key.** It would be an EOA chosen by the live owner while idle, bound to the revision and cleared on owner migration. The problem is vaults: SessionVault ownership can rotate without the controller being told, so a stored key would keep a rotated-out principal's ability to stop or grief the app until the next idle `configure`. That is exactly the "cached old owner authority" the task forbids. ERC-1271 cannot be used in the critical path at all, because it is an external call.

**Explicit governance assumption.** If the ledger or identity is down, the owner **cannot stop the app alone**. During that outage, emergency revocation exists only through the owner-selected witness quorum. The design does not cover owners who are unwilling to delegate stop authority to their quorum.

Not re-reading `lifecycleOwner` is safe here because:

- a Running state requires `a.owner == ledger owner` at start;
- `canTransfer` is false while Running or pending;
- the witness set cannot be changed while Running.

The quorum that signs is therefore the one the current owner configured for this run. Witnesses must be EOAs, as in the baseline `_quorum`.

## 6. Reimbursement

- The submitter pays its own gas upfront. A finite reserve cannot guarantee inclusion.
- `payee = 0` gives a self-funded, permissionless report.
- The deadline is at most 120 s. After it expires, witnesses must re-sign a fresh intent for the same generation, and the first one included wins.
- The reimbursement debt is pull-only. A payee that rejects ETH reverts only its own claim and can claim to another address. The debt is never lost.
- The L1 data fee on Base needs an authenticated receipt or price source. A deferred oracle read reflects a different block's L1 basefee, so it is not that source. This is **left pending (BLOCKED)**. A future capability may charge at most `l1UnpricedCapWei` and must be idempotent per intent digest. Because the residual is not reserved, the owner's later `withdraw` can leave it unpaid. The relay carries that risk knowingly.

## 7. Financial cutoff: required paired-ledger patch (BLOCKED)

A controller-only patch **does not fix paid accounting**. Retrying the schema-2 `lifecycleEnd` later would:

- credit and refund at the later `block.timestamp`, overcharging the tenant for `[cutoff, now]`;
- let `creditProven`, `settle`, `refund`, `sweepEscrow` and the `_extendFundedRuntime` called by `fund`/`fundFor`/`fundWithAuthorization`/`fundEth` mutate the revoked run in the meantime.

The candidate constructor refuses `lifecycleSchema() != 3`, so it cannot be paired with the unpatched ledger. This is tested.

Required changes to `deploy/lifecycle/EnclaveDeployments.sol` (schema 3):

1. Store `_runGen[id]` (uint64) and the run start, written in `lifecycleStart(id, host, operator, runGeneration)`.
2. `lifecycleEndAt(id, gen, host, op, cutoff, stopped)`, `onlyLifecycle`:
   - **Idempotency.** If the runner is cleared and `_endAck[id] == ack`, return `ack` without mutating.
   - Require `_runGen == gen && runner == host && runnerOperator == op && runStart <= cutoff <= now`. A stale settlement can then never clear a newer run.
   - Credit the runner up to `min(cutoff, leaseUntil, provenUntil if proofRequired)`.
   - **Deferred-tail refund.** If `leaseUntil > cutoff`, compute `tail = (leaseUntil - cutoff) × rate`, then `balance6 += tail` and `spent6 -= tail`.
   - If `stopped`, set `active = false`.
   - Clear the runner, `creditedUntil` and `provenUntil`. Store `_endAck`. Return `ack`.
3. Pending gate: `pending(id)`, meaning the controller's `offline(id).pending` is set and `runGeneration == _runGen[id]`, read by view call from the bound controller.
   - `_creditRunner` clamps `upto <= cutoff`.
   - `creditProven` clamps `provenUntil <= cutoff`. This is the **final-proof ceiling**: an honest runner may post a final checkpoint up to the cutoff before reconcile, never beyond it.
   - `_extendFundedRuntime` returns early. Funds land in `balance6` and are never re-burned into the revoked run.
   - `refund` and `sweepEscrow` revert, because the `refundableOf` reserve uses `leaseUntil` and would be wrong mid-pending.
   - `lifecycleFunded` returns false.
   - `setShares`, `setAppRef`, `setConfig` and `transferDeployment` are already blocked by `runnerOperator != 0`.

**Conservation.**

- `balance6 + spent6` is unchanged by the end. The tail only moves from `spent6` to `balance6`.
- For the run, the final `spent6` equals `(cutoff - leaseStart) × rate`.
- The runner's credit is at most `(min(cutoff, proven) - start) × rate6`, capped by escrow. Escrow that was never credited becomes refundable once the reserve is zero.
- Seconds in `[lastProof, cutoff]` stay charged to the tenant but are not earned by the runner. This is the baseline forfeiture rule. Publisher and platform cuts left the contract at funding time.

**Liveness dependency.** If the paired ledger can never acknowledge, the record stays pending forever. The ETH budget and the tail stay frozen. By design, there is no silent "abandon". Recovery is governance-level, for example a ledger `retire()` plus migration, and still has to be specified.

**Size.** The candidate ledger is about 24469 B, leaving roughly 107 B of EIP-170 headroom. Items 1–3 (new storage, a new entrypoint, a cross-contract view in `_creditRunner`, `creditProven`, `refund` and fund) will very likely exceed that. They need size qualification or a refactor, for example moving the disabled legacy surface out or adding a companion contract. A companion contract would need a new address, and no existing grant authorizes one. **BLOCKED.**

`MockPairedLedger` implements items 1–3 for the lease meter only. It models no escrow, USDC, fees or refunds, and it is evidence of the intended semantics, not of the production ledger.

## 8. Test map (`LifecycleEmergencyTest`)

| Test | Demonstrates |
| --- | --- |
| `offlineIsDurableWithLedgerIdentityOracleAndPayeeAllUnavailable` | All dependencies down: the normal path reverts, while the emergency record commits with zero calls to the ledger, identity or oracle (`expectCall` count 0). A rejecting payee keeps its debt and can claim to a sink. Conservation holds. |
| `admissionDenialBoundsOnlyReimbursementNeverTheRecord` | A gas price above the cap blocks `transition`. A self-funded report still records and spends no budget. |
| `reimbursementPricedAtOwnerGasCapAndL1LeftUnpriced` | Execution is priced at `maxGasPrice`. The L1 residual is recorded unpriced. |
| `invalidQuorumForgeryDomainAndAssignmentMismatchesFail` | Sub-threshold, empty, duplicate, unsorted, outsider, high-s, wrong-controller, wrong-chain and Transition-typed approvals fail. So do wrong generation (±1), revision, host or operator, the wrong from-state, a Running or Unknown target, both deadline bounds, the wrong payee, cap overflow and an unknown id. |
| `exactRetryIsNoopNeverRechargesAndCompetingIntentFails` | An exact retry, even with empty approvals or from another sender, returns false with no charge or state change, before and after settlement. A competing intent fails. There is exactly one ledger end. |
| `normalQuorumQueueFirstMakesSameGenerationEmergencyFail` | Race safety. |
| `pendingSettlementBlocksStartResumeConfigurePolicyStopAndTransfer` | Pending gates hold. Reactivation works only after settlement, and the new run carries the new generation. |
| `emergencyStopHoldsWithdrawUntilExactSettlementThenDeactivates` | Withdraw is blocked, then allowed. The ledger is deactivated at reconcile. |
| `emergencyQueuesKeepFenceBackoffAndCrashHoldRequiringOwnerResume` | The fence and backoff are preserved. Five reports trigger a crash-hold, and only the owner can resume. |
| `paidRunSettlesAtRecordedCutoffDespiteLaterSettleFundAndProof` | `settle`, a late proof and a fund during pending honor the cutoff. Settlement happens at cutoff, not at the reconcile time. Conservation holds. A retry is a no-op. |
| `failedOrMisboundSettlementKeepsOfflinePending` | A down ledger, a reverting end, settle-at-now and a wrong-generation ack are all refused and the record stays pending. It then settles honestly. |
| `referenceLedgerRefusesForeignStaleOrOutOfRangeSettlement` | Ledger-side binding (reference model): only the controller can end, and a mismatched gen, host or operator or an out-of-range cutoff is refused. |
| `normalOwnerStopRemainsAndIsAckBoundAtCurrentBlock` | Owner stop still works on the normal path. It is still coupled to the oracle. |
| `candidateRefusesToPairWithUnpatchedSchema2Ledger` | No silent pairing with the unpatched ledger. |

Keys are deterministic public `keccak256("…test…")` labels used with `vm.sign`.

## 9. Host registry offline: separate proposal, not implemented

App stop is not host offline. `emergencyOffline` revokes one app's assignment and says nothing about the host. Registry `deregister` stays operator-only and is unchanged.

The app's witness set is **not** reused for hosts. A host-offline writer would need its own explicit policy:

- The **authenticated host owner**, resolved through the accepted `EnclaveHostOwnership` authority or an explicitly authenticated owner-enrollment protocol, enrolls a host witness set while the host is idle: 3–16 EOAs, with threshold × 3 > n × 2. The registry payout wallet is not ownership authority; receiving revenue cannot grant offline-policy control.
- The policy is bound to `(hostId, registry entry nonce, attested measurement or proofKey epoch)`.
- Witnesses sign `HostOffline(hostId, entryNonce, epoch, deadline)` in a distinct domain.
- The host report must create an explicit authenticated ledger liveness/status record consumed by Live Enclaves and new-work admission. An admission-only flag does not resolve zombie host ledger entries. It does not silently inherit authority over running apps; each app's own quorum and protected boundaries handle assignment revocation.
- It needs its own native budget and a registry patch or companion contract (a new address, unauthorized). Not built.

## 10. Remaining dependencies and limitations

- **BLOCKED:** the schema-3 paired-ledger patch (section 7), including EIP-170 qualification, real escrow, refund and fee interaction, and a test against the real `EnclaveDeployments`.
- **BLOCKED:** an authenticated Base L1 receipt or price capability for the deferred L1 reimbursement.
- **Consumer routing.** Until reconcile, the legacy-shaped ledger row still names the runner. Routers, permit issuers and runners must use controller state and generation (`funded()`, `assignments`) and the off-chain durable fence. Witnesses must durably fence the generation before signing, as the existing rule already requires.
- **Controller size:** root measured 17,253 runtime bytes with the pinned compiler/settings. Actual Base transaction costs and fee sufficiency remain unqualified.
- There is no liveness escape for a ledger that never acknowledges (section 7).
- The author did not run tests. Root subsequently compiled and validated the prototype; see the status and evidence above.
