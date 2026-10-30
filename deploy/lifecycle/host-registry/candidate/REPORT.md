# EnclaveHostLifecycleRegistry — author report (r1, source only)

**Status:** this is source only. See `REVIEW-REPAIRS.md` for the independently reviewed corrections after author completion. Nothing has been compiled, tested, size-checked, deployed or wired into production.
The Claude author used no `forge`, `solc`, shell, network tools or Git. Root owns the bounded EIP-170, ABI and real-contract runs.
The plan's SHA256 `11ef2fe1…f633` matches the entry in `input-manifest.json`. The author did NOT recompute it
(no shell). The original `EnclaveRegistry`, `EnclaveHostOwnership` and `EnclaveHostPaymaster` were read and left
unchanged.

## Files

| File | Purpose |
| --- | --- |
| `contracts/EnclaveHostLifecycleRegistry.sol` | A single new contract. It has no imports, libraries or linking, and `pragma solidity 0.8.35`. |
| `test/HostLifecycleRegistry.t.sol` | `MockWallet` (an ERC1271 test owner), `LifecycleBase` (deterministic keys, intent builders) and 26 enrollment/offline/authority/recovery tests. |
| `test/HostLifecycleSponsorBudget.t.sol` | 16 tests for sponsor dedup, reservation, protected budget, zero-safe reimbursement and recovery funding. |
| `test/HostLifecycleReview.t.sol` | Eight independent post-author review regressions, not yet executed. |
| `foundry.toml` | solc 0.8.35, optimizer runs 1, via_ir, prague, offline, ffi=false. forge-std is remapped to the pinned path. No `code_size_limit`. |

The tests use `vm.prank/warp/deal/sign/txGasPrice/expectRevert/expectCall/startStateDiffRecording`. They do NOT use
`vm.etch`. The test keys are fixed constants: operator `0xA11CE`, owner `0xB0B`, payer `0xFA7E`/`0xFA7E2`,
new owner `0xC0FFEE`, new operator `0xD00D`, verifiers `0x1001-3`, reporters `0x2001-3`, the post-transfer quorum
`0x3001-3`, and outsiders `0x4001-3`, `0x5001-3`, `0x6001-3`, `0x7001-3`, `0xBAD`.

## Authority diagram

```
                 payer (EOA or ERC1271)                       anyone
                   │ signs SponsorReservation{anchorId,...}      │ publishTrustAnchor(verifiers,thr,version,maxAge)
                   ▼                                             ▼   (immutable; id = hash(params, publisher))
  depositSponsorFunds ─► sponsorFunds[payer] ──reserveBootstrap──► reservations[id]  (hardware/job dedup slots)
                                                                     │
operator sig + owner sig (EOA/ERC1271/msg.sender) over Enrollment ───┤  receipt signed by ≥thr anchor verifiers,
                                                                     │  bound to intent digest/gen/hw/descr/att/res
 independent submitter (pays gas) ─► registerQualifiedHost ──────────┘
                                         │ atomically, or revert:
                                         ├─ _rows[hostId]            (schema-5 row; `active` derived)
                                         ├─ authority[hostId]        {owner, pendingOwner, revision=1, policyHash}
                                         ├─ _reporters[hostId]       {sorted EOA keys, strict-majority thr, revision}
                                         ├─ hostBudget[hostId]       {payer, balance, protectedReserve, caps}
                                         ├─ hostState[hostId]        {generation=1, ONLINE, qualification digests}
                                         └─ credits[submitter] += min(measured gas, listingGasCap); rest → payer

 accepted owner ── setHostPolicy / proposeHostOwner → acceptHostOwner(newReporters)  ⇒ revision++ and the
                   reporter set is REPLACED in the same call (old signatures die immediately)

 reporter quorum (ecrecover only) ─► recordHostOffline ─┐   only local SLOADs + ecrecover precompile
 stored operator | accepted owner ─► deactivateHost  ───┴─► _recordOffline: status=OFFLINE, lastOfflineDigest,
                                                            then clamped charge: budget.balance → credits[payee]
 payee ─► claimHostReimbursement(to)   (pull; the only ETH push besides withdrawSponsorFunds)

 OFFLINE ─► recoverQualifiedHost(accepted owner + (rotated) operator + fresh receipt for generation+1) ─► ONLINE
```

There is no contract owner, admin, pauser, platform verifier or upgrade hook. The only parties who can take a
host offline are its stored operator, its accepted owner, and the quorum that owner installed.

## ABI (external surface)

Legacy-compatible reads:
- `get(bytes32)`, `getPage(uint256,uint256)` return the schema-5 `Enclave` tuple unchanged. Its `active` field is
  `hostState.status == ONLINE`; the stored bit is never written.
- `count()`, `idAt(uint256)`, `idOf(string)`.
- `registrySchema()==5`. This is still the tuple-shape signal for decoders.
- `hostLifecycleSchema()==1` and `registryFeature()==keccak256("EnclaveHostLifecycleRegistry/feature/1")`.
  Consumers must compare these exactly, never with `>=`.
- `CAP_*` constants.

Lifecycle:
- `registerQualifiedHost(Enrollment, ReporterPolicy, QualificationReceipt, bytes operatorConsent, bytes ownerConsent, bytes[] qualificationApprovals) returns (bytes32 hostId)`
- `recoverQualifiedHost(Recovery, QualificationReceipt, bytes operatorConsent, bytes ownerConsent, bytes[] qualificationApprovals) returns (uint64 generation)`
- `recordHostOffline(HostOffline, bytes[] reporterApprovals) returns (bool)`. It returns `false` only for an exact retry.
- `deactivateHost(HostOffline) returns (bool)`

Authority:
- `proposeHostOwner(bytes32,address)` (`address(0)` cancels)
- `acceptHostOwner(bytes32,ReporterPolicy,bytes32)`
- `setHostPolicy(bytes32,ReporterPolicy,bytes32)`
- `authority(bytes32)`, `reporterPolicy(bytes32)`, `hostState(bytes32)`

Operator configuration (never lifecycle):
- `setPrices`, `setCaps` (must keep `CAP_HOST`; region ≤64 bytes). `setProofKey` only acknowledges the same key; a new key requires fresh qualified recovery.
- `setPayoutWallet`, `clearPayoutWallet` (semantics unchanged; cleared when recovery rotates the operator)

Qualification and sponsors:
- `publishTrustAnchor(address[],uint8,uint32,uint64,bytes32)`, `trustAnchor(bytes32)`
- `depositSponsorFunds()`, `withdrawSponsorFunds(uint256,address)`
- `reserveBootstrap(SponsorReservation, bytes payerAuthorization)`, `cancelReservation(bytes32)`
- `reservations`, `hardwareReservation`, `jobReservation`, `hardwareHost`, `usedDigest`, `sponsorFunds`

Budget:
- `fundHostOffline(bytes32)` (payer only), `releaseHostBudget(bytes32,uint128)`, `hostBudget(bytes32)`
- `credits(address)`, `claimHostReimbursement(address)`

Hash helpers:
- `domainSeparator`, `hashListing`, `hashReporterPolicy`, `hashEnrollment`, `hashRecovery`, `hashReceipt`,
  `hashOffline`, `hashReservation`, `descriptorOf`

**Deliberately absent:** `register`, `registerRelay`, `heartbeat`, `deregister`, `setMeasurement`. A code change
goes through Offline, then a qualified recovery carrying the new `repo/measurement/proofKey`. The registry also
cannot list relays (see gaps).

EIP-712 domain: `("EnclaveHostLifecycleRegistry","1",chainid,this)`. The typehash strings are in the source. Two
deliberate simplifications:
- `Enrollment.listing` is signed as an opaque `bytes32 listingDigest` (`hashListing`).
- `ReporterPolicy.reporters` is hashed as `keccak256(abi.encodePacked(address[]))`, the standard EIP-712 array
  encoding.

Wallet UIs therefore show `listingDigest` as a hash. Off-chain signers must reproduce `hashListing`. Only
`hashOffline` is cross-checked by an independent test computation. All other tests sign the contract's own
digests, so a typehash typo elsewhere would go undetected until an off-chain signer is built against it.

## Storage

| Slot group | Key | Content |
| --- | --- | --- |
| `_ids` | — | append-only `bytes32[]` of host ids (only successful enrollments) |
| `_rows` | hostId | schema-5 `Enclave`. Endpoint ≤256 B, repo ≤128 B, region ≤64 B. |
| `authority` | hostId | `owner, pendingOwner, revision(uint64), policyHash` |
| `hostState` | hostId | `generation, status, changedAt, qualificationExpiry, hardwareId, descriptorDigest, qualificationDigest, resourceDigest, trustAnchorId, lastOfflineDigest` |
| `_reporters` | hostId | `keys[] (≤16, strictly ascending), threshold (strict majority), revision` |
| `hostBudget` | hostId | `payer, balance, protectedReserve, perTransitionCap, l1FeeAllowance, maxGasPrice` |
| `_anchors` | anchorId | `verifiers[] (≤16), threshold, version, maxReceiptAge (≤30 d), metadataDigest, publisher`. There is no setter. |
| `reservations` | reservationId (= EIP-712 digest) | payer, status, deadline, submitter, gas caps, host/hw/job/anchor, amounts |
| `hardwareReservation` / `jobReservation` | hw / job id | dedup slots. A bootstrap reservation takes the hardware slot; every reservation takes a job slot. Freed only by cancelling an unconsumed reservation after its deadline. |
| `hardwareHost` | hw id | which host a hardware id was qualified for. One host per hardware id. |
| `usedDigest` | digest | consumed enrollment, recovery and receipt digests |
| `sponsorFunds` / `credits` | address | payer-entitled unreserved wei / pull reimbursements |

ETH accounting: `this.balance == Σ sponsorFunds + Σ reservations(RESERVED: protected+listingCap) + Σ hostBudget.balance + Σ credits`.
Every movement is between these buckets, except deposits/funding (in) and `withdrawSponsorFunds`/`claimHostReimbursement` (out).
No reviewer has proven this invariant yet. A Foundry invariant test is recommended.

## How each plan constraint is met

- **One authority.** Owner, revision, reporters, generation, budget and row live in one contract.
  `_installPolicy` increments `revision` and replaces `_reporters` in the same call. Offline intents bind
  `authorityRevision`, so old signatures fail immediately (`test_policyChange…`, `test_ownerTransfer…`). An
  empty reporter set is refused while Online, and recovery requires a non-empty one.
- **Offline is external-call free.** `recordHostOffline` performs only SLOADs plus `ecrecover`.
  `deactivateHost` checks only `msg.sender` against the stored operator or owner, with no ERC1271. This is
  asserted with `expectCall(…,0)` and a state-diff call scan while the ERC1271 owner wallet reverts.
- **Fenced replay.** The intent binds the domain (chain and contract), hostId, generation, operator, revision,
  target, evidence, deadline, payee and maxCharge. Duplicate signers are refused by strictly ascending recovery.
  An exact retry returns `false` and charges nothing only after current binding, deadline and quorum/caller validation. Any other report against an already Offline host reverts
  `NotOnline`. Authentication failures revert before any state write.
- **Zero-safe reimbursement.** The state write and events come first. Then
  `charge = min(min(maxCharge, perTransitionCap, balance), sat((gasUsed+overhead) × min(tx.gasprice, maxGasPrice)))`.
  This cannot revert: `charge ≤ balance`, the multiply and add saturate, and the credit is backed by the same wei.
  A zero balance, zero maxCharge or zero payee yields a charge of 0, and the transition is still recorded.
- **Zero-ETH operator.** The operator and owner only sign, and any account submits. The submitter is reimbursed
  `min(measured gas × capped price, listingGasCap)` as a pull credit. This happens only after every check passed,
  and the remainder returns to the payer. A reservation can pin an exact `submitter`.
- **Qualification.**
  - The payer names an immutable `trustAnchorId` in a signed reservation. The owner and operator bind the same id
    in their signed intent.
  - The receipt must be signed by ≥threshold distinct anchor verifiers over `QualificationPassed{…}`. That typed
    message contains no boolean: verifiers sign only on success.
  - The receipt binds the exact hostId, hardwareId, `descriptorOf(repo,measurement)`, attestation digest,
    resource digest, a non-zero test digest, the consuming intent digest and the generation.
  - Freshness: `issuedAt ≤ now < expiresAt` and `expiresAt − issuedAt ≤ maxReceiptAge`.
  - Receipts are single-use.
  - An anchor that contains the operator or owner is refused (`NotIndependent`). This only rules out obvious
    self-attestation. It is NOT Sybil resistance.
- **No recurring renewals.** `qualificationExpiry` is historical. Nothing on chain expires a listed host. Fresh
  capacity and attestation are off-chain duties.
- **Protected funds.** While Online, the payer can release only the balance above `protectedReserve`. Only the
  payer funds or releases. A foreign party cannot touch it. Once Offline, the whole remaining balance is
  releasable, because owed reimbursements already sit in `credits`. Recovery requires
  `balance ≥ protectedAmount ≥ perTransitionCap`. New reservations must match the recovery protected amount exactly. A new payer can take over only a zero-balance budget, so funds are never mixed.
  Recovery never touches `credits`.
- **No global veto.** There are no admin selectors. A new anchor never affects existing hosts.

## Threat and failure assumptions

1. **Trust anchor (verifier quorum).** This is the trust root for qualification. A colluding threshold of
   anchor verifiers can qualify a fake host for any payer who chose that anchor. The anchor is explicit and
   payer-selected, not universal.
2. **`hardwareId` uniqueness.** This is only as good as the verifiers' attestation parsing. On chain it is an
   opaque digest.
3. **Reporter availability.** This is an operational assumption. If more than `n − threshold` reporter keys are
   lost, quorum reports stop working. Operator/owner `deactivateHost` remains available when they are reachable.
4. **No inclusion guarantee.** A valid quorum or a funded budget does not guarantee inclusion. If fees exceed
   the payer caps, the submitter is under-reimbursed but the transition still lands if mined. Chain or RPC
   outage leaves a durable pending report off chain. The node must deny locally and must not claim the
   transition landed.
5. **Fee estimates.**
   - `OFFLINE_GAS_OVERHEAD = 40k` and `LISTING_GAS_OVERHEAD = 90k` are flat estimates of intrinsic and calldata
     gas.
   - `tx.gasprice` includes the priority fee and is capped by `maxGasPrice`.
   - Base L1 data fees are NOT measured or reimbursed. `l1FeeAllowance` remains an inert signed ceiling;
     this version has no authenticated L1 fee settlement mechanism and creates no L1 reimbursement debt.
     A submitter must cover actual L1 fees; this contract must not be described as fully funding inclusion.
   - None of this is "fully funded" against arbitrary fee spikes.
6. **Self-reimbursement churn.** The operator or owner can churn Offline→recover cycles to pull up to
   `perTransitionCap` per transition into a payee they choose. Each cycle needs a fresh payer-anchor receipt and
   `balance ≥ protectedAmount`. The total exposure is bounded by the payer's deposit. Payers should keep
   `perTransitionCap` small.
7. **Reporters can choose `payee`.** This is intended: they are reimbursed. The charge is bounded by the signed
   `maxCharge` and the payer caps.
8. **Owner power.** The owner fully controls its own host's quorum, including setting it to keys it controls.
   This is the intended host-local authority.
9. **Payout wallet.** `setPayoutWallet` keeps the legacy "declared by the wallet" semantics. Recovery that
   rotates the operator clears it.
10. **ERC1271 is used only on normal paths** (enrollment, recovery, reservation consent). 7702-delegated EOAs
    have code, so they go through ERC1271.
11. **Reentrancy.** The only value pushes are `withdrawSponsorFunds` and `claimHostReimbursement`. Both zero the
    balance before calling (checks-effects-interactions). ERC1271 calls are `staticcall`.
12. **`getPage` with large `n`.** It is clamped to the list length (the legacy version reverted on overflow). It
    is still gas-bound for very large registries.
13. **Hardware ids are never released.** `hardwareHost` keeps a host's earlier hardware ids after recovery onto
    new hardware. This is intentional (a retired box cannot list as another host), but an operational unbind
    path is not provided.

## Deviations from the plan text (for reviewer decision)

- `recoverQualifiedHost` keeps the plan's parameter list. It reuses the current reporter set, and recovery does
  not bump `revision` because the generation already fences it. To change reporters, call `setHostPolicy`
  while Offline first.
- `acceptHostOwner` supports msg.sender only. There is no signature path; contract wallets call it through their
  own execution.
- `registrySchema` stays 5, because the tuple is unchanged. The new feature is signalled by
  `hostLifecycleSchema == 1` and `registryFeature`.
- The reporter threshold must be a strict majority (`2t > n`). This is my reading of "strict quorum threshold".
- `fundHostOffline` is payer-only, which keeps each budget to a single entitled payer.
- There is no separate "pending fee settlement" record. Charges are moved into `credits` at transition time, so
  there is nothing pending on chain.
- `lastSeen` now changes only on lifecycle transitions.

## EIP-170 and deployment requirements

- The source is one contract with no external libraries, so there is nothing to link.
- **The size is unknown** because nothing was compiled. Error strings were replaced by custom errors to save
  bytes.
- If root's measurement exceeds 24,576 bytes, here is the contingency, in order:
  1. Drop the public `hash*` helpers. Clients and tests then compute EIP-712 off chain. This saves roughly 2–3 KB.
  2. Move `publishTrustAnchor`/`_anchors` into a separate immutable `HostTrustAnchors` contract, pinned by
     constructor address. Enrollment/recovery would read it through an external view call, which the plan
     allows on normal paths. The offline path is unaffected.

  Either change must be pinned and re-reviewed. Neither has been done.
- Possible compile nits I can't rule out without a compiler:
  - `bytes32 == 0` literal comparisons (written as `x == 0`). If solc rejects them, change them to `bytes32(0)`.
  - Stack depth in the 13-field `reservations` getter. `via_ir` is expected to handle it.
- Deployment: no constructor arguments and no owner. The profile pin must record this contract's address,
  runtime code hash, the `hostLifecycleSchema`/`registryFeature` values, and chain id.

## Consumer inventory and integration gaps (not implemented)

| Consumer / port | Current source | Required change | Status |
| --- | --- | --- | --- |
| `availability/observation.mjs` `createObservationLoader` | `resolveHost` → `if(!host?.active) continue` → `verifyReceipt` (active fleet only) | Keep it for the active fleet. `resolveHost` must target the NEW registry address, check `hostLifecycleSchema()==1` exactly, and carry `hostState.generation` into receipts and denial floors. | missing |
| `verifyCandidateQualification` (HOST-LISTING-PORTS §1) | does not exist | Off-chain pre-listing verifier that produces the `QualificationReceipt` for an anchor. It runs isolated tests and fresh attestation, and computes `resourceDigest`/`testDigest`. Verifier group operations are not specified. | missing |
| `reserveHostBootstrap` sponsor selection (§2) | does not exist | Prefer a paid-work online host. Fall back to the scoped Stripe path only on VERIFIED absence; a read failure is not absence. Produce `sourceEvidence`. On chain only the signed claim and hardware/job dedup are enforced. The source verification is entirely off chain. | missing |
| `prepareQualifiedListing` / sender reconciliation | does not exist | Build the exact intent. Reconcile the mined/pending nonce and `reservations[id].status` before retrying. | missing |
| `reconcileHostOffline` and local journal | does not exist (`network/host-liveness.mjs` and `registry-reconcile.mjs` are not in the snapshot) | Durable pending report. Deny locally first, then submit `recordHostOffline` and reconcile against `hostState`. Never restore permission on timeout. | missing |
| `VerifiedAvailableCapacity` projection (§4) | `site/components/fleet-list/fleet-list.js:160-161,260` reads raw `cpuShareFree/gpuShareFree` | Replace with the projection keyed to `{hostId, generation, hardwareId, resourceDigest}`. Do not fall back to raw `/availability`. | missing |
| EnclaveDeployments / EnclaveProofOfTime | read `EnclaveRegistry.get()` (prices, proofKey, payoutWallet, active) | Redeploy or pin against the new registry. The tuple is compatible, but the address and profile differ. They must reject the legacy registry under the new profile. | not in snapshot, unverified |
| `EnclaveHostPaymaster` | sponsors only `register(...)` on the legacy registry | Incompatible with the new path, which has no `register` selector. The new path reimburses gas in-contract instead of through ERC-4337. Do not point the paymaster at this registry. | intentionally not reused |
| `EnclaveHostOwnership` | separate wallet authority | Superseded for hosts in this registry. It must not be consulted by offline paths. | left untouched |
| Relays (`registerRelay`) | legacy registry | Not supported here. Relays either stay in the legacy registry under an explicit profile rule, or need their own reviewed path. | open decision |
| Existing hosts | listed in the legacy registry | No migration. Each host must re-enroll with a qualification. | operational plan missing |
| Serving / storage / secrets / ingress / discovery | not in snapshot | Must consume the exact registry, profile and generation, with durable revocation floors across restarts. | not inventoried beyond the plan |

## Test coverage map (written, NOT run)

Covered, as Foundry unit tests against the real contract with no mocks of the registry:
- atomic listing failure
- receipt authenticity, resource/hardware/descriptor/intent binding and freshness
- self-appointed verifier, and an anchor the payer did not authorize
- operator/owner consent, including ERC1271
- canonical `active=false` through `get` and `getPage`
- no external calls on offline, with the owner wallet down
- exact retry
- independent EIP-712 digest
- wrong domain, duplicate signer, outsider, insufficient quorum, wrong generation/target, expired
- policy change and owner transfer invalidating the old quorum
- empty-reporter refusal
- operator/owner/contract-wallet graceful shutdown
- no foreign veto or admin selectors
- no legacy reactivation
- recovery: newer generation, stale receipt, accepted owner and payer anchor required, operator rotation
- sponsor hardware/job dedup across fallback; fallback evidence required; payer consent, funds and bounds
- reservation does not list; a consumed reservation cannot be reused; submitter binding
- cancel/refund
- protected reserve locked while Online; budget survives later failure; pull claims
- zero maxCharge, extreme gas price clamp, zero gas price (no unproven L1 allowance), 1-wei budget clamp
- recovery payer handover without touching credits

Not covered:
- Compile, size and actual pass/fail. Root must run these.
- A fund-conservation invariant/fuzz test.
- A gas-limit test of a 16-of-16 quorum.
- Off-chain sponsor selection: "read failure ≠ absence" can't be tested on chain.
- Capacity projection.
- Real `EnclaveDeployments`/profile integration.
- Authenticated profile pins.
- A reporter-key-loss runbook.

Some tests rely on forge-std features whose availability in the pinned version was not checked: the
`AccountAccess` field names and `expectCall` with a count. If either is missing, the test fails to compile; it
does not wrongly pass.
