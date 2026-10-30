# DNS/KVM post-refund runner release and old reserve recovery

Read-only source review, October29,2026 America/Phoenix. Root reports DNS refund approved and dashboard stopped/runtime0, but expired lease, both escrow values and old reserve remain. Do not repeat that refund or a62's included transfer. Root owns fresh receipts/chain/host identity and financial submission. No live reads, requests, signing, test/build or code edits performed here.

## Exact existing per-app routes differ by host implementation

Source root: /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source. These are pinned checkout files, NOT proof of the actual loaded NucBox process or deployed route. Root must match the active implementation before using one.

Linux supervisor:
- `supervisor.js:9698–9704`: audit defines mine as same enclave ID AND unexpired lease. Inactive records stop locally, but proveAndRelease runs only if mine. Thus refund of an already-expired attached lease can leave the chain lease attached indefinitely on this path. This is a source-supported explanation, not independent observation of the current host.
- `POST /v1/admin/deployments/:id/release`7292 requires ADMIN_TOKEN and a local `_onchain` record whose status is running or claimed. It stops only that app, marks expired, installs a15minute local re-claim holdoff and asynchronously proves/releases. A stopped DNS record likely fails409 not_releasable. Do not change local status to evade it or invoke global pause/caps.
- `DELETE /v1/deployments/:id`7356 is the existing owner-controlled alternative. It requires a real local record and ownerAuth("api.restart")/mayAct, but does not require running/claimed state. For `_onchain`, it stops that app, marks terminated and invokes proveAndRelease asynchronously even if already stopped. A valid scoped EnclaveSession can authorize it; a bearer wallet token only matches rec.owner exactly, so a vault-held record is not automatically accessible to its controlling wallet's bearer. `?evacuate=1` adds a120second default re-claim holdoff; unnecessary for an already inactive ledger record and may delay same-host restoration.
- Authentication5188–5224 binds a session header to method, exact original URL/raw body, scope and fresh record authorization. Reuse actual signing API; do not copy stale headers.
- The JSON response says lease released before the transaction has confirmed! Verify the actual Released receipt and runner/lease reset independently, never treat HTTP200/local terminated as chain completion.
- proveAndRelease11058 first attempts a final proof via proveFinalPeriod11025, then releaseLease9273. Final proof is conditioned on recorded service/start and lease metadata; do not fabricate or extend service claims. releaseLease retries up to4 times on any failure, including receipt timeout, with15/30/45/60second waits. A hash with unknown receipt must be reconciled before another route/manual submission; duplicate API calls would create additional work, not safely confirm prior work. sendOperatorTx9091 serializes this process's signer and waits receipt; this checkout sends a direct operator transaction, not proof the installed route uses reserve sponsorship. The release helper uses configured DEPLOYMENTS_ADDRESS, so it also needs actual rec._ledger/config identity validation.

Windows native node:
- `windows/node/agent.mjs:588–606` exposes deployment listing/read/logs and POST restart. The generic `/v1/deployments/<id>` branch has NO method condition: a DELETE request to that URL simply returns the current row with200, without stopping or releasing. Do not interpret it using Linux semantics.
- `host.mjs:1905` inactive handling calls private #stopApp2247, which retires the isolated domain and clears tracking/local serving state but never calls ledger.release.
- Private #giveUp2062–2104 retires first, coalesces concurrent giveups and invokes chain.releaseDeployment only after a chain read says this enclave owns the runner. It is used for failures and cap-drop flows, not exposed as a standalone per-app public release API in this source. Changing hosting caps/global paused is not an acceptable substitute; it could affect other apps.
- `windows/node/chain.mjs:254` has an existing releaseDeployment(id) primitive through the same serialized operator sender209–230. It simulates, signs with the locally initialized operator, waits a successful receipt and returns its hash; selected transient errors get one retry. A separate imported-module process would not share the running process's queue/nonce state, so it is not an already-qualified safe operator route. No operator key was read/exported, no helper prepared or invoked here.
- If current NucBox is this Windows implementation and has no installed additional route, there is no qualified per-app HTTP release surface in the reviewed source. Root can use an already-established serialized operator/conduit route only after verifying it actually exists; source primitive availability alone is not production execution readiness.

## Sponsorship and order

EnclaveLeaseGasReserve._check215–229 evaluates KIND_RELEASE before inactive/retired/lease-expiry checks, so stopped or expired records can still use sponsorRelease when current runnerOperator matches and reserve policy/balance/caps permit. Initial pause/block/enabled/empty/epoch-cap gates still apply; finish enforces actual charge/per-op/signed cap and balance. This is contract behavior, not evidence the current host sender selects it. Keep the old owner reserve available until the exact runner release is confirmed if that route will consume it. Do not withdraw it first and strand the release.

After runner release, root re-reads refundable/ownerEscrow/earn. Any additional refund is the newly qualified residual-tail action, not repeating the completed first refund. If amount0, do not call refund again. Do not change rate/maxRate/runner proof just to free escrow.

## Review-ready reserve ownerCall structure (not a transaction)

Chain: Base8453, subject to fresh root identity verification.
Outer from: controlling wallet0x0b2d009c0c9Af05b12100D77F3c815fea822eE61.
Outer to: historical owner vault0xB794C4DD0e1C5E6B72281799F282BfdE7654345D.
Outer value:0.
Outer ABI: ownerCall(address target,bytes data), direct wallet transaction.
Target: verified old reserve0x12A3f873041Dec436DaA0085B766a399A6fA3639.
Inner ABI: withdraw(bytes32 id,uint256 amountWei,address to).
Inner to: that SAME controlling wallet, never the vault (the vault may not accept plain ETH and there is no need to strand it there).
IDs:
DNS0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c.
KVM0x9a28642bed115105c07bea1131c56c83ae2843ce4daf07958ab36437c0528a6b.
Amount: fresh confirmed remaining balance of reserveOf(id,B794), after any pending sponsored release resolves. Historical numbers are NOT calldata. No concrete amount or transaction request is prepared until root supplies verified current state.

Exact v2 ownerCall851 checks msg.sender==fixed owner, target code, excludes token/self/multicall, invokes target with no value and enforces post-call token solvency. It is DIRECT ONLY; session key, typed Release, or relay `/sessions/owner` cannot substitute an arbitrary ownerCall signature. Existing source's general ABI does not make it an owner-signed off-chain operation.

Reserve.withdraw349 reads budgetKey(id,msg.sender), which here is(id,B794), checks no in-flight transient operation and sufficient balance, decrements it and emits Withdrawn(id,B794,wallet,amount), then sends ETH to wallet. No current ledger-owner check: this works before or after the ownership transfer. It does not withdraw runtime USDC or change record owner. Verify successful receipt/exact event and old bucket delta; concurrent release can reduce the available amount and make a stale withdrawal revert, so no blind retry.

The new wallet bucket/configuration/claimants/deposit are separate operations. Recovering old ETH into the wallet does not by itself enable session-funded gas at the destination. Existing owner permissions/funding caps remain bound to their actual contract/version. Keep concrete new-session spending review with root's fresh budget/scopes; no copying of old counters as fresh authorization.
