# Narrow immutable library factoring proposal

Status: source/design review only. Nothing has been extracted or deployed.
The latest measured ledger remains 25,302 bytes (726 over EIP170).

## Existing pattern and why a direct copy is unsafe

The repository already has `EnclaveLedgerBandwidth` at
`contracts/EnclaveDeployments.sol:1872`, called by the non-lifecycle ledger.
It receives typed storage references from the ledger and uses a statically
linked Solidity library, with no configurable delegate target. Its public
`credit`, `splitFunding`, and `refund` establish the existing extraction pattern.

Do NOT link that library unchanged: its credit uses now rather than an exact
emergency cutoff; its refund has a retirement/stranger exception and does not
carry the schema-3 pending protections. The schema-3 copy must preserve the
reviewed new behavior, not import the old semantics to save bytes.

## Proposed source change

Append a distinct `EnclaveLifecycleAccounting` library in the same candidate
Solidity source, following the existing source/type pattern. No storage-layout
change, new administrative setter, removed public ledger selector or arbitrary
call dispatcher. Only these existing bodies move:

1. `_creditRunner`: ledger computes the authenticated cutoff with `_runEnd` or
   `_requireRun` exactly where it does now. Wrapper passes `d`, `_earn[d.id]`,
   `earned6`, explicit cutoff, proofRequired(), provenUntil[d.id]. Library
   copies horizon/proof/escrow clamps, checked arithmetic, zero-run/zero-credit
   behavior, meter update and RunnerCredited event exactly. It cannot choose
   now in place of the caller's cutoff or consult admission dependencies.
2. `_splitFunding`: ledger retains `_feeShare`; library receives existing
   storage references, token, fee router, payout, payer, rate, value, feeTo/cut.
   Move existing ceil/rounding, owner-only refundable attribution, transfer
   order and router call unchanged. No added rate/recipient policy.
3. Refund finalization only: ledger keeps `_requireOwned`,
   `_creditUnlessPending`, `refundableOf`, and positive-amount refusal before
   entering the library. Move ownerEscrow/escrow subtraction, balance=0,
   active=false, transfer-to-owner and identical events. Library also checks
   positive amount with LedgerRefused(17); token failure remains code19.
   No retirement flag, caller-supplied recipient or independent refund auth.

Keep schema-3 `lifecycleEndAt`, ack, run generation/start, pending validation,
all owner/lifecycle gates and every public ABI in the ledger. The library's
storage-write functions use compiler-generated delegatecall and Solidity's
library direct-call protection. Third parties can delegatecall it in their own
storage context, but cannot obtain this ledger's storage or redirect its
immutable link. This is a trust-bearing code dependency and must be pinned.

Expected size reduction is NOT measured; no promised byte saving. If necessary
review a second extraction of already-validated import bodies separately,
rather than moving unrelated runtime policy or deleting live APIs.

## Consumer and link/binding consequences

- ABI consumers retain the same ledger selectors, error selectors, event topics,
  record layout and schema. `getPage` is used by supervisor and admin migration;
  `fundEth` by site/core/fund.js; importFees/Earn/Caps by admin migration and
  scripts/migrate-ledger-delegates.mjs. These are not safely removable dead APIs.
- Existing general artifact builder (`scripts/build-contract-artifacts.mjs`)
  emits library creation/linkReferences. Existing fork rehearsal
  (`scripts/network/rehearse-bandwidth-rollout.mjs`) deploys libraries before
  linking/deploying their consumer. Reuse that approach, not its transactions.
- Lifecycle artifact builder currently rejects placeholders and emits no library
  bundle. It MUST be updated before qualification: include creation and runtime
  link references, library artifact/source hash/runtime size, compiler/settings,
  and unresolved templates clearly marked NOT deployed pins.
- A code pin on the linked ledger commits to library ADDRESS, not the code
  residing there. Migration preflight and the independent adapter profile MUST
  authenticate library address + deployed code hash at the same authenticated
  snapshot as ledger/controller/prover. Detect missing/wrong/duplicate or
  unresolved links and reject them. Pin library runtime's Solidity self-address
  binding as well; template hash is not actual deployed hash.
- There is no runtime link setter, mutable address book lookup, proxy, generic
  target argument or fallback path. A different library means a different
  linked ledger deployment and a newly reviewed profile.
- The local runner must distinguish size of unresolved compiler templates from
  actual linked deployment qualification. Unresolved placeholders never count
  as linked success. Forge's real test deployment/linking must be recorded and
  all library code independently satisfy EIP170. No vm.etch/size override.
- Build changes and code pins are source-only until coordinator review and the
  independently authorized production deployment. No existing ledger/library
  changes; no global book/host changes in this chat.

## Required validation after source review

Compile only once under a reviewed bounded allocation. Check exact ledger and
library sizes, no nested unreviewed links, unchanged storage layout/public ABI,
no new configurable authority. Then independently reviewed real-ledger tests:
all baseline lifecycle/proof cases and 13 cutoff cases; original cutoff/escrow
conservation; zero-rate horizon; exact retry/stale tuple; owner/delegate refund,
stranger rejection; duplicate payment prevention; funding with fee + rounding
edges; token/router failure rollback. Event topics/order must remain unchanged.
Add negative artifact/profile tests for wrong/missing library code and address,
and a positive fully linked local deployment. These do not qualify live Base
positive authority, sponsor/offline reserves or remaining independent policy.
