# Root review of author draft

Author completed successfully. Root review added four reserve regressions and
corrected the reserve cap below. The first compiler run was stopped by the
256 MiB job guard at 259 MiB before tests ran. The coordinated 512 MiB rerun
then reproduced exactly two reserve failures in the original draft and passed
all 32 tests (18 distinct scenarios) in the corrected candidate, with zero
failures or skips. Runtime is 17,253 bytes, below EIP-170. This validates the
prototype with its mock ledger, not the actual schema-3 ledger or production.

## Finding requiring regression and correction

The initial `emergencyOffline` draft allows target Queued or Stopped, but caps
the immediate execution reimbursement at the entire app budget in both cases.
For target Queued this can consume part of the protected final-stop reserve.
It contradicts the normal transition invariant that a non-Stopped transition
preserves that reserve. Recording authenticated Queue must still succeed;
instead limit its reimbursable execution amount to the ordinary spendable
portion (leave the protected reserve intact), potentially zero. Stopped may
use the protected portion. The relay consciously accepts any unreimbursed
amount within its signed policy; do not create an uncapped debt.

Regression: run an app with balance just above the final-stop reserve, submit
a quorum emergency Queue with a valid maximum cap large enough to consume the
remaining budget, then assert the offline record exists and budget is still
at least the stop reserve. Also cover balance at/below reserve; recording
must succeed with zero Queue reimbursement. Final Stop may spend reserve.

The corrected candidate preserves `stopReserveWei + 1` for Queue, matching the
normal non-Stopped reserve invariant. `review-baseline/` retains the original
draft plus the same four tests for an independent failing-run comparison.

## Host authority documentation correction

The author report initially identified the registry payout wallet as the host
owner. Root coordination correctly rejected this. The report now requires the
accepted EnclaveHostOwnership authority or explicit authenticated enrollment;
receiving payouts grants no ownership or reporter-policy authority. Host
offline must produce an authenticated ledger liveness/status record, not merely
an admission flag. No host-offline implementation is present in this candidate.

The existing initial `EnclaveHostOwnership.proposeOwner` path itself requires an
active registered host and operator sender, followed by separate acceptance.
Bootstrap therefore needs atomic qualified admission/enrollment/budget or
authenticated pre-enrollment before online effect; it cannot simply rely on
that existing path for an unregistered candidate. This dependency belongs to
the coordinated host bootstrap work, not this app-offline controller.

## Scope limitations to retain

- This draft requires a new schema-3 paired-ledger port. The current schema-2
  ledger must be rejected rather than pretending delayed settlement is safe.
- L1 reimbursement is explicitly unpriced and not claimable/reserved. This
  prototype does not qualify full Base fee reimbursement or guarantee enough
  gas for an independent reporter.
- Host registry offline and production sender/receipt/permit integration
  remain separate work. A controller unit test does not prove those paths.
