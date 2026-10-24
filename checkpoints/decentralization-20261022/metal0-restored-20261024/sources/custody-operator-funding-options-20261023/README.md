## Production execution — October 24

The human approved the exact paired claim plus funding proposal with “do it.” Funding plan 0x0bf69bf0b0c115c88a4c5669ab37df15b3b4e5d591cc5f9fb7391c065827aa8b completed and verified on both configured providers. A (fund/clear): 0x0fa029b735dec660d22ca26b2a18d06a112ca0c232be0cd8541c0de0ed474fc3. B (restore): 0x3595c6120c68b2f03a5b6ad4abf50f7449e05ab47b4aa30a6a0b62e8f20a9911. Both succeeded in block 53013229; exact delegation, storage, binding and nonce postconditions verified. Transfer: 5000000000000 wei; accepted aggregate fee upper bound: 1067891383346 wei (cap 2000000000000).

An earlier plan refused on changed fees before signing and created no journal. No uncertain attempt was replaced. After the verified restoration and an original-startup fee check, the original control resumed. The exhausted old keeper remains stopped. This is completed account maintenance, not custody activation or architectural decentralization. Historical preparation notes below retain their original context.

---

# Proposed operator funding maintenance — not executed

This package prepares a narrowly pinned Base EIP-7702 operation: sponsor29479 sends5e12wei to metal0 operatorC9 in a transaction which clears its current delegation; the next sponsored transaction restores exactly executor8900baca. Aggregate outer fees are capped at2e12wei. No new contract, admin change, generic executor, forced-funding constructor or manual proof-key helper is used.

The public proposal is `outputs/decentralization-audit/operator-maintenance-proposal-20261024.md` in the task workspace. Approval for the temporary delegation change and use of canary funds is pending. No production signatures, transfers, or delegation changes have occurred.

## Preparation and safety

- `bin/observe.mjs`: read-only production observation of the exact two protected apps. Its output is explicitly non-executable and asserts no quiescence.
- `bin/prepare.mjs --quiesce FILE`: read-only executable-plan preparation only after root verifies all signers stopped and outstanding lease signatures expired or reconciled. Verifies two-provider code, binding, nonce, balances, raw executor storage and views, actual live leases, and all L1/L2/operator fee bounds.
- `lib/sender.mjs`: takes injected keys; validates authority approvals and plan pins, repeats fresh preparation and fee checks, verifies all signatures and exact fields, writes both signed transactions privately and durably before broadcasting, and verifies both-provider receipts plus restored code, nonce, storage, views and binding. Unknown outcomes retain the journal. Resume never signs again.
- `bin/root-send.mjs`: root-only wiring to existing operational keys, only after exact plan approval and inactive control/keeper units. Resume reads no private keys. This production wiring has not been executed.
- `ROOT-OPERATIONS.md`: stop, quiesce, prepare, send, recover and resume sequence. The tenant VMs and original custodian are preserved. Control image activation remains separate.

The timing profile requires1200s left on each lease, at most120s plan age, and a120s verification cutoff. It replaces the earlier infeasible1800s preparation threshold, not the control image's1440s cutover/600s watchdog guards. The cutoff detects unresolved maintenance; it cannot guarantee recovery during chain/network failure. Never resume lease signers while the operator is undelegated.

## Evidence

Root's two-provider observation at approximately00:26UTC Oct24 matched all configured pins, with no findings. Total fee upper bound was1069676386805wei, below2e12wei. This was read-only, not an executable authorization.

Current root local suite:26/26 passing (12 real Anvil/revm protocol cases,8 sender/recovery cases,6 plan cases), under the unchanged512MiB queue. Sender tests exercise A mined/B unavailable, recovery using identical bytes without re-signing, stale nonce, changed fees, provider receipt disagreement, journal failure, missing approval, observation refusal and expiration. Source-only tests do not establish production Base txpool behavior. Earlier fe7e105 has the initial protocol tests and assessment; ROOT-STATUS-20261024.md records completion after Claude's weekly limit interrupted source work.

## Limitations

- Real protocol behavior is exercised on local Anvil/revm with generated throwaway keys and the reviewed executor source; deployed bytecode is pinned by hash, not rebuilt here.
- Two public providers supply state agreement, not independent light-client verification.
- The sponsor also serves as the original custodian submitter; root must exclude concurrent submissions. Fresh settled nonce checks detect activity but do not reserve a nonce.
- If A mines and B is unavailable, C9 is codeless and lease calls can return success without doing work. Signers remain stopped until restoration verifies. A conflicting authority nonce needs a newly reviewed restoration, not automatic re-signing.
- Future L1/oracle changes after signing can alter costs; bounds are refreshed immediately before signing, not a timeless guarantee.
- Manual Linux stop/resume orchestration and production root-key wiring remain unexecuted. Approval is pending.
