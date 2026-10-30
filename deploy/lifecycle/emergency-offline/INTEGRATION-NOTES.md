# Integration review requirements

This is a source-stage checklist. Nothing listed here establishes production
qualification or authorizes a new contract, signer, grant, or payment.

## Independent reporting path

The emergency sender needs a narrow authenticated read of the controller's
enrolled witness policy, assignment, generation, revision and offline record.
The normal admission adapter reads a much wider dependency closure. A broken
catalog, identity, ledger, or fee oracle must not make that broader admission
read the only way to prepare an emergency revocation. Do not replace proof
verification with RPC labels to achieve this separation.

An independent relay must keep the exact submitted intent and reconcile its
receipt to canonical state. Unknown submission does not authorize another
payment or a different nonce. A stale-generation intent must fail, and a
failed receipt must not be treated as evidence of an offline transition.

Immediate routing denial is distinct from the eventual canonical offline
record. Protected ingress, secret and storage boundaries must enforce the
same generation revocation and permit-expiry rule. Stopping a manager process
alone does not prove that the old host has lost access to protected resources.

## Review scenarios

1. A registered quorum revokes a live generation with every external
   financial/identity endpoint configured to revert. The offline record still
   commits, pending liabilities are explicit, and no external call is made.
2. Unknown ids, absent policy, insufficient quorum, duplicate signers, invalid
   recovery values, wrong chain/controller and stale generation/revision fail.
3. Retrying the exact accepted intent changes neither generation nor balances.
   A conflicting intent for the old generation cannot replace the cutoff.
4. Expired intents and caller-selected retroactive/future cutoffs fail. The
   effective stop time is the accepted chain record's time unless a separately
   reviewed authenticated earlier cutoff protocol exists.
5. No new assignment, policy weakening, withdrawal or owner transfer can make
   the pending old financial state disappear. Reconciliation binds its exact
   old assignment and cutoff, not merely the app id.
6. A settlement failure leaves the offline record and obligation intact.
   A successful acknowledgement cannot be replayed to credit or refund twice.
7. Fees remain capped and separately claimable. A reverting payee or missing
   authenticated fee source cannot roll back revocation or fabricate a cost.
8. Paid accounting cannot accrue beyond cutoff through checkpoint, settle,
   funding, refund, share-change or sweep paths. Test with a real paired ledger
   before expanding a mocked component's qualification claims.
9. App stop does not change host registration, host capacity or unrelated apps.
   Host-offline authority must be separately enrolled by the host owner.

## Operational limit

Protected native gas and an independent reporter remove dependence on the
failed host's cooperation. They do not guarantee inclusion during a chain
outage, unbounded gas prices, loss of quorum, or censorship of every available
submission path. Pending state and immediate off-chain denial must remain
visible in those cases. No periodic on-chain heartbeat is introduced.
