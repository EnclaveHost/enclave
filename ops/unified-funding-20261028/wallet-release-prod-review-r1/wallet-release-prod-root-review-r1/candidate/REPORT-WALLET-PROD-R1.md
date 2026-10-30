# Wallet release PROD-R1 — owner-elected PRODUCTION release (source only)

Authored 2026-10-29 with Read/Grep/Write/Edit only. **No command, test, build, RPC, browser, wallet action, promotion, release or deployment was run.** Nothing here has been shown to pass. Root still has to review and test it.

## What changed
- **`wallet-release-store.js`**: Promote records go in the **same** schema-1 object store under their own key prefix `wp1:` (`promoteKey`, `kind:"promote"`). Seed `wr1:` Release records are never rewritten, relabeled or migrated, and the IndexedDB version stays 1. `putIfAbsent` now reads both key ranges for chain+ledger+vault and checks `fenceConflict` in the **same readwrite transaction** that writes the intent. MemoryJournal does the same in one synchronous step.
  - Fence rules:
    - A nonce already recorded by the other kind is refused in any state.
    - A Promote is refused while any Release or Promote by this owner is unresolved (any deployment).
    - A Release is refused while any Promote by this owner is unresolved.
    - Only `cancelled` or `finalized` counts as resolved. `conflict` stays reserved.
    - Release-vs-Release behaviour is unchanged from the seed.
  - A finalized promote record can be replaced by a later reviewed promotion. Release records never can.
  - New read-only method: `vaultRecords`.
- **`wallet-release-chain.js`**:
  - `readCatalog` reads book `appCatalog`, then `getApp` and `getVersion` at the snapshot block with the same reader, re-checks the block hash, and parses the ref the way `SessionVaultLib.parseRef` does.
  - `ownerReviewHash` binds identity, the full prestate (row/content/public/balance/escrow/cap/fee/reserves), the held env/promoted/createdBy, the delegation, the census policyHash and the catalog.
  - `issueOwnerReview` / `isOwnerReview` produce a WeakSet-issued object, created only on the owner's click and never persisted.
  - `evaluate` drops `prod-custody` only for a promoted row whose fresh review hash equals the issued release review. A look-alike or stale review gives `review-changed`. **With no election, the default `unpromoted`, `content-drift` and `prod-custody` blockers are unchanged.**
- **`wallet-release-census.js`**: `assess` now takes the row's actual `Held.env`.
  - Source PROD + prod-only grant: no new environment. The grant is preserved or narrowed according to the actual wallet delegation, and setAppRef/setConfig are never allowed.
  - Source STAGING: `prod-only-gain` still blocks.
  - Other delegated vaults (`other-vault-gain`), unknown delegates, source delegates and unknown env masks are unchanged.
  - `authority.policyHash` is now passed to the gate.
- **`wallet-release-controller.js`**: `release(prodElection)`. For PROD rows the catalog is read in every gate (eligibility, pre-sign, post-sign/pre-dispatch). There is a `promotion-pending` fence blocker. The record stores `ownerReview` and `commitment` only when the row was elected. The STAGING flow, the synchronous `assertLive` after the dispatching CAS and the uncertainty paths are untouched.
- **New `wallet-release-promote.js`**:
  - The exact Promote typed-data guard (9 fields matching the vault's `PROMOTE_TYPEHASH`).
  - Canonical `promote(...)` calldata encode/decode.
  - `verifyPromoteOutcome`, which checks the exact nonce, sigHash, calldata content, a successful receipt in a canonical block, exactly one `Promoted(id, commitment, appRef, configCid)`, held env 2 with the intended commitment, the unchanged ledger content/owner, and `ownerNonceUsed`. A foreign nonce stays unresolved; a failed receipt or wrong event is a conflict; a reorg is pending.
  - `createPromotionController`, which runs the shipped `sdk.ownerOperation({op:"promote",...})` through a guarded signer and relay with the same order as Release: intent before prompt → sigHash only → full revalidation → dispatching CAS → synchronous assertLive → one POST. There are no retries.
  - Promotion is offered only when env is 2 and every release blocker other than `unpromoted`/`content-drift` is clear. The promoted content is the current appRef/configCid **unchanged**, and the catalog slug/publisher/label and the row's isPublic come from the chain read.
- **`wallet-release-view.js`**:
  - Under the blockers it offers either "Review promotion (step 1 of 2)" or "Review production release". Each rendered review has one sign button, and each click issues one review object.
  - A promotion never leads into a release: after the promotion, refresh shows its journal state, and step 2 is offered only when the chain shows a promoted row and the fence is clear.
  - The text explains that Promote binds content/catalog/public, that Release binds only deployment/to/nonce/deadline, that vault promotion enforcement is lost, that the preflight is not atomic, and that runtime mutation limits remain.
- `sessions.js` is not changed (the slot was already wired). There are no new dependencies or assets.

## Tests (authored, not run)
`enclave/test/wallet-release/prod-election.test.mjs` contains 12 tests:
- default PROD refusal (including a look-alike election)
- two explicit steps with no auto-chaining
- already-promoted election
- STAGING unchanged and never offered promotion
- census source env (prod-only grant on PROD vs STAGING), unknown and source delegates
- active/lease/escrow gates
- content/catalog/publisher/public/promotion/balance/session/delegate drift, plus drift during the prompt
- typed-data, calldata and POST exactness
- invalidation during the dispatching CAS, and two tabs
- uncertain/reload/foreign-nonce/reorg/failed/wrong-event promotion with no resend and no early Release
- the shared nonce fence in both directions, including another deployment and an old schema-1 Release record kept as-is
- the **exact shipped SDK** (`../shipped-sessions.mjs`, imported unconditionally): Promote, then a separate Release

The seed tests (census/controller/chain-store/view) and `../root-boundaries.test.mjs` were not edited.

Bounded root command:
`WALLET_CENSUS_LEDGER_CREATOR=0x120ba39e91395273496c4c7d065733c9db461dbb:1 node --test enclave/test/wallet-release/ ../root-boundaries.test.mjs` (run from `candidate/`; keep the existing `WALLET_RELEASE_SDK_FIXTURE` setting for the seed SDK test).

## Risks root should check first
- Seed assertions that compare full `review` objects or exact journal logs could be affected: the review now has extra null fields for STAGING, and promote puts log as `put:promote:intent`.
- `IdbJournal.putIfAbsent` now uses `getAll` and `IDBKeyRange`. It needs a real-browser run of `held-card.fixture.html?store=idb`.
- The exact SDK `ownerFromProvider` request shape is assumed to be `eth_signTypedData_v4`.

## Limits and unfinished work
- The catalog contract's code hash is not pinned. The vault re-checks the label/slug/publisher on-chain (`LabelMismatch`), but what the owner sees comes from a single reader, not a two-provider read.
- Release cannot bind content. Between the last check and inclusion, a change is detected afterwards, not prevented. Once wallet-owned, vault promotion enforcement and relay custody refusal of unpromoted PROD no longer apply. App runtime endpoints and installed hosts are not covered (see funded review).
- A `conflict` record of either kind keeps that owner's cross-kind fence closed until a human reviews it. There is no automatic way out of this, by design.
- Not proven: browser IndexedDB, real multi-tab behaviour, live Base data, relay acceptance of `op:"promote"`, installed host policy.
- DNS/KVM stay blocked (escrow and reserve). Nothing was promoted, released, refunded, funded or deployed.
