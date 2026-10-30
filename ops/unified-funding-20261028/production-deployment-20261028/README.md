# Production additive deployments — October 28, 2026

All four owner-approved creation transactions are confirmed by the reviewed wallet helper using two-provider canonical transaction, receipt, block membership, exact runtime and constructor verification. The prior unknown first request later returned its hash; it was reconciled without resending or resetting the journal.

These transactions deploy two linked libraries, LeaseGasDexAdapter and FundingSessionVaultFactory (including its implementation). They do not activate the relay, migrate the original $30 session, approve USDC, grant new spending authority, or restore queued apps. Original factory/address-book/custody and session remain unchanged. Canonical observations are not an assertion of finality.

Public receipts and exact runtime hashes are in receipts.json. Full durable private journal retains offer/unknown/reconciliation history. Receipt fee sum is gasUsed × effectiveGasPrice plus reported l1Fee; it is not a dollar estimate.
