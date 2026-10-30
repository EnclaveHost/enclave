# Emergency app-offline review input

Source baseline: `EnclaveHost/enclave`, lifecycle candidate commit
`ecf364c0a81b9176163d254dcfc9685572bde0cd`. This report is source analysis,
not a live deployment assessment or an authorization to send transactions.

## Current coupling

| Path | Current dependency | Consequence |
| --- | --- | --- |
| Controller `transition` | Live `ledger.lifecycleOwner` equality before every transition | Failed ledger read prevents a Stop, even with configured quorum signatures. |
| Non-running target authentication | `ownerAuthority` evaluates identity before operator/quorum fallback | An external lookup failure can prevent checking an otherwise valid quorum. |
| Running-to-stopped state | Synchronous `ledger.lifecycleEnd` before writing controller state | A settlement revert rolls back the entire offline record. |
| Charge calculation | Synchronous L1 fee oracle | Oracle failure rolls back the offline record. |
| Reimbursement | Synchronous ETH call to submitting payee, requiring success | A rejecting payee rolls back the offline record. |
| Fee caps/reserve | Shared transition admission guard | Insufficient reimbursement budget prevents authenticated offline, even when the sender volunteers to pay its own transaction. |
| Runner failure | `health.ended` unconditionally chooses Queue | Positive spendable balance smaller than queue charge can strand failure reporting rather than choosing Stop. |

Normal deployment transfer is already constrained by `canTransfer`: stopped or
unknown, empty transition balance, expired fence, and cleared ledger runner.
There is no demonstrated normal running-owner-transfer exploit. Emergency
authorization nevertheless must use its own explicit policy and not assume a
failed ownership read is positive evidence for a cached owner.

## Accounting dependencies that a deferred stop must address

The existing `_creditRunner` is local accounting. It does not call the proof
service, token, registry, or external oracle. A missing final proof checkpoint
does not itself prevent release; it forfeits unproven service under current
rules. Do not manufacture a dependency on a failed proof service.

Retrying `lifecycleEnd` at a later timestamp is **not** equivalent to stopping
at the time of the authenticated offline record. Refund tail and credits use
the current block timestamp. Delayed reconciliation must bind the exact old
assignment and effective cutoff and must not settle beyond it.

Other ledger paths that can change the financial result while a stop is pending:

- `creditProven` updates `provenUntil` and credits the runner.
- `settle`, `refund`, and `sweepEscrow` call `_creditRunner`. `setShares` also
  contains that call, but already refuses an assigned runner; retain that guard.
- Funding invokes `_extendFundedRuntime` while the runner is still assigned.
- Paid-service prover records may advance independently of controller state.

Every relevant path must consult the authoritative cutoff or remain blocked
pending reconciliation. Already withdrawn earnings cannot be repaired by
adjusting a later local credit counter. Consumer routing must observe the
controller offline fence even when the legacy-shaped ledger row still names a
runner. A controller-only prototype cannot establish these properties for the
actual paired ledger.

## Authority and money remain separate

An emergency endpoint can revoke the current assignment using the already
enrolled owner-selected witness quorum and exact generation/revision. It must
not authorize a replacement host or ignore a missing witness policy. Domain,
deadline, replay and duplicate-signature checks remain mandatory. A quorum-only
path supplements the owner's normal stop path; it does not justify retaining
an obsolete owner key as emergency authority.

The submitting relay still needs native gas upfront. Recording offline must
not invent a reimbursement grant or unlimited debt. Signed reimbursement caps
are ceilings, not evidence of actual cost. Fee reconciliation needs an exact,
authenticated cost source; a failed oracle cannot be replaced with a caller's
unverified receipt assertion. A pending debt or refund must remain visible and
idempotent until actually settled.

Host registry offline is a different protocol. Its current operator-only
`deregister` cannot use an application's witness policy implicitly. Host owner
enrollment, attestation binding, reporter policy, generation and native budget
must be specified separately before any host-offline writer is implemented.
