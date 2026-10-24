# Proposed metal0 operator funding maintenance

Status: prepared and tested locally; **not executed**. No funds, delegation, or admin controls have changed.

The existing operator account is delegated to the nonpayable Enclave lease executor. An ordinary ETH transfer reverts. Its remaining ETH cannot fund normal control registration or custody host-owner enrollment.

Proposed two-transaction operation on **Base (8453)**:

1. The existing canary submitter `0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C` sponsors an operator-signed EIP-7702 authorization temporarily clearing the delegation, and transfers **0.000005 ETH** to operator `0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB` in that same transaction.
2. The same sponsor immediately submits the next transaction restoring **exactly** the existing executor `0x8900baca2167873ba2f8a8bae8b4876e6396d343`. No new contract is deployed.

The aggregate network-fee cap is **0.000002 ETH**. Total sponsor expenditure is at most **0.000007 ETH** under the prepared bounds. A read-only two-provider observation at approximately 00:26 UTC estimated aggregate fees of 0.000001069676386805 ETH. Fresh nonce, code, balance, lease and fee checks are mandatory immediately before signing; that observation is not executable approval.

All operator signers, including the temporary keeper and control, must be stopped and outstanding signed lease deadlines allowed to expire before the operation. The original tenant VMs stay running. Each lease must have at least 1,200 seconds remaining; the transaction-verification cutoff is 120 seconds. Keepers resume only after the exact delegation, nonce, raw lease storage, executor views and reserve binding are verified on two providers. Both signed transactions are written to a private durable journal before either is broadcast. Retries reuse identical bytes.

There is a real interruption risk: if the first transaction mines and the second does not, the operator remains temporarily undelegated. Lease calls to an undelegated account can misleadingly succeed without doing work. The sender therefore reports recovery required and keeps signers stopped. The prepared restoration transaction must be resubmitted and verified; a conflicting nonce needs a freshly reviewed restoration. The time cutoff detects a problem; it cannot guarantee chain availability.

Local evidence: actual Anvil/revm EIP-7702 processing, 12 protocol tests; 8 sender tests, including interruption after the first transaction, identical-byte recovery without re-signing, stale nonce, fee changes, receipt disagreement and journal failure; 6 plan tests. These do not prove production Base txpool behavior or replace fresh live verification.

Approval sought: permission to use the existing canary submitter funds for this exact maintenance and temporarily change the operator delegation as described. The operational keys are already available to the host; no administrator wallet signature is needed for these two transactions. Separate custody enrollment and address-book/catalog signatures remain necessary later.
