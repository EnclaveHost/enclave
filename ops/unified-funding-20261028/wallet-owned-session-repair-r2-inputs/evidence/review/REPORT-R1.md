# wallet-owned-session-create-r1: author report

This is source only. I ran no tests, builds, compiles, chain/RPC reads, signatures, transactions or deployments, and I don't claim that any test passes. EIP-170/EIP-3860 size and gas have not been measured; root has to treat them as an acceptance gate. Root reviews, runs and activates everything separately. The 60 migration-UI passes are earlier evidence for a different change and don't count for this one.

## What is implemented (positive paths, in source)

1. **Contract: create → same-ID transfer → fund as owner** (`contracts/WalletSessionVault.sol` `_create`).
   - The owner's wallet signs a `WalletSessionGrant` in a new EIP-712 domain, "Enclave Wallet Sessions" v1. The grant names the pinned `ledger`.
   - The session key signs a `SessionCall(deploy.create)`. It has the same struct as before, but in the new domain.
   - `execute` checks, in the same order as legacy: liveness, deadline, lane nonce, P-256 signature, the action mask, the fee ceiling, attestation, then `_spend(fund+fee)`, charged once.
   - It captures one ledger, and the book must still resolve to the pinned ledger (`LedgerMoved` otherwise). Then `SessionVaultLib.create` runs. This is the existing deployed library, reused unchanged. It derives the catalog publisher fee and requires a named paid app within the fee cap.
   - It asserts that the vault owns the new empty record, calls `transferDeployment(id, owner)` and asserts that `ledger.get(id).owner == owner`.
   - It then writes the binding, calls `factory.noteCreated(id)`, and finally calls `fundFor(id, fund6, owner)` with the exact approval. The allowance must be back at 0.
   - The relay fee goes to the router.
   - The return value is the ledger's original ID. In one receipt the events are: Created (naming the vault), DeploymentTransferred, factory Bound, vault Bound, and SessionOp.
   - Any revert anywhere unwinds the nonce, spend, record, transfer, binding and funding, because it is all one transaction under `nonReentrant`.
   - The destination is the owner set once by `initialize` from the factory. It never comes from the request body.
2. **Every later action is scoped** (`_bound`). A session can only act on a record that:
   - this vault bound (`state == BOUND`),
   - is held by the owner's wallet on the pinned ledger right now,
   - is in an environment the session covers, and
   - whose current ledger `appRef` app (re-read, not taken from any UI name) is in the session's `apps[]`, or the session has `anyApp`.

   This is applied to fund, setAppRef (both the current and the target app), setConfig, setShares, setMaxRate, setActive and refund. Fund also re-checks that the publisher fee is genuine and that a paid app is named. Records the wallet owns that this vault did not bind are refused with `NotHeld`.
3. **`app.publish` is explicitly unsupported.** It is refused in the grant (`Unsupported(8)`) and at dispatch. It is not silently dropped, and publishing has not been migrated.
4. **The wallet controls policy, separately from custody** (`WalletSessionPolicy.sol` and `policyOf`). The owner has three operations, either called directly or signed in the new domain and bound to the current revision:
   - `approveContent(id, appRef, configCid, revision)` (PROD only),
   - `setEnvironment` (this also re-binds a detached record and always clears the approval),
   - `detach`.

   There is no global operator, no `ownerCall` and no release/adopt.
5. **Shared JS resolver** (`relay/wallet-session-policy.mjs`), with these consumers:
   - the relay custody gate (`createCustodyGate`, given `walletPolicy`). This is the same `custodyRefusal` that api-relay.js passes to `secrets.js` (fetch), `secrets-release.mjs` (attested ticket/release) and `shield-secrets.mjs`;
   - the relay row rule (`sessionRowRefusal`, 4th argument);
   - relay submission (`createSessionsService.isVault` recognises vaults of pinned wallet factories. `execute`, `sessionOf` and `seqOf` have the same ABI, so the existing quote → execute path relays a wallet-v1 SessionCall, and the verified session is tagged `version: "wallet-v1"`);
   - the host verifier (`createSessionApiAuth({ walletPolicy })`: `verify` tags the version, and `refusal`/`visible` apply the same rule).

   api-relay.js builds a single resolver from `WALLET_SESSIONS_PINS` and passes it to all of the relay sites.
6. **Shield TOCTOU:** `shield-secrets.mjs` now re-runs `custodyRefusal` on the current row after the attestation and before any secret byte is read. Without this, a policy change during the attestation would not be caught, because policy changes don't alter the row fingerprint.
7. **CLI** (`deployViaSession`): for `s.version === "wallet-v1"` it reports the actual ledger owner from every RPC, aborts if that owner isn't the wallet, keeps the same ID, and never says "held by vault". It tells the user that delegation is required and that it covers every wallet record, but it never sends a delegation.
8. **SDK** (`sdk/sessions/src/wallet.ts`, new and not exported): the new domain, types, grant builder (checks the ledger, refuses publish, accepts hex app IDs only), explicit version assertion and call digest.

## Action / environment table (enforced on-chain unless marked off-chain)

| Action | STAGING bound record | PROD bound record | Not bound by this vault / foreign owner / detached |
|---|---|---|---|
| deploy.create | allowed if session env ∋ staging, app in scope, rate ≤ cap, paid app named; result is wallet-owned + bound staging | same, bound prod, **approved = 0** | n/a |
| deploy.fund | scope + genuine fee + prepareFund; payer = wallet; **no delegation needed** unless prepareFund must re-base the rate (setMaxRate) | same | refused (NotHeld / NotMine) |
| deploy.setAppRef | current app AND target app in scope; needs the wallet's delegation | **refused** (WrongEnvironment) | refused |
| deploy.setConfig | in scope; needs delegation | **refused** | refused |
| deploy.setShares / setActive / refund | in scope; needs delegation; refund pays the wallet | same | refused |
| deploy.setMaxRate | in scope; checkMaxRate; needs delegation | only lowering to cap (checkMaxRate prod) | refused |
| app.publish | **unsupported** (grant + dispatch) | unsupported | unsupported |
| ownership transfer | no session action exists | — | — |
| api.* (off-chain, relay + host) | wallet-v1 session: own vault's binding, env ∩ session envs, current app in apps[]; no ledger delegation needed | same; staging-only session refused | refused; legacy session on a bound row refused |
| secret release (secrets.js / secrets-release / shield) | released (existing staging semantics) | only if approved == keccak(abi.encode(appRef, configCid)) of the **current** row | detached / void (transferred away) / proven legacy-unbound: plain-wallet rule; `invalid` or unreadable: refused / 503 |

What invalidates authority:
- setEnvironment clears the approval and bumps the revision.
- detach removes all session reach.
- If the wallet transfers the record away, the binding becomes `void` and `_bound` fails with NotMine.
- revokeAll/terminate end sessions.
- Content drift stops PROD release.

Owner-signed operations carry the revision, so an approval signed before a change cannot land after it.

**Honest limitations:**
- Approvals match content. If the record goes back to exactly the same `(appRef, configCid)`, an earlier approval is still valid for that content.
- Mutable data inside the app is not covered by any of this.
- A ledger `setDelegate` that the wallet gave to the **legacy** vault still lets that legacy vault act on the new records on-chain. The deployed legacy bytecode can't be patched. The off-chain consumers refuse legacy sessions on bound rows.

## Protocol / binding discovery identity
- **Pin** = `{factory, runtime codeHash}` plus chainId plus the consumer's ledger. The code hash covers the factory's immutable implementation address. The resolver also checks `PROTOCOL == keccak("enclave.wallet-session.v1")` and `factory.ledger() == ledger`.
- **Per decision** (read fresh): `creatorOf(id)` → vault; `isVault(vault)`; `vault.owner()` (set once at initialize, so cached) must equal `row.owner`; `policyOf(id)`.
- There is no owner allowlist, no Enclave admission, and nothing read from the request, a URL or an arbitrary `owner()`. Anyone can deploy and use the reviewed factory.
- A malformed pin, wrong code, wrong chain or unreadable read **throws**. Callers fail closed, as they already do on custody errors.
- With no pins configured, the resolver answers `inactive`. That means the new version is not activated on that consumer.
  - **Activation blocker:** every relay and host must carry the pin before any wallet-v1 vault is used. This can't be enforced from source.

## Finite grant / budget separation
- This version has its own vault per owner: different factory, CREATE2 address and domain. Balances, op counters, `seqOf` and owner nonces are separate.
- Budgets are uint128-bounded escrow with a per-period cap, an ops-per-period limit, a fee ceiling, an app-fee ceiling and a rate ceiling.
- The grant's `ledger` field binds the wallet's consent to the pinned ledger.
- Nothing is migrated.

## Files

**New:**
- `enclave/contracts/WalletSessionVault.sol` (vault and factory)
- `enclave/contracts/WalletSessionPolicy.sol`
- `enclave/relay/wallet-session-policy.mjs`
- `enclave/sdk/sessions/src/wallet.ts`
- `enclave/contracts/foundry/test/WalletSessionVault.t.sol`
- `enclave/test/wallet-session/consumers.test.mjs`

**Edited** (marked `wallet-session-create-r1`; the existing blocks are preserved):
- `relay/sessions.mjs`
- `relay/api-relay.js`
- `relay/shield-secrets.mjs`
- `windows/node/session-api-auth.mjs` (imports `../../relay/wallet-session-policy.mjs`)
- `windows/node/host.mjs` (the restart refusal now passes appRef/configCid)
- `cli/enclave.mjs`

**Not edited:** SessionVault.sol, both ledgers, the catalog, the secrets Solidity, deployment records, the funding/fee/quarantine modules, `relay/secrets.js` and `relay/secrets-release.mjs` (both already call the shared `custodyRefusal`), sessions-abi.mjs, package files, dist, the UI and all old tests.

**Dependencies:** none new. Uses viem, which is already in the relay, and forge-std (`vm.signP256`, `vm.publicKeyP256`, `vm.mockCallRevert`).

## Root commands (bounded, local, not run by me)
- `forge build --sizes` must pass with WalletSessionVault under 24576 bytes and initcode under 49152.
  - The vault links the existing `SessionVaultLib`. Production linking must use the deployed library address.
- `forge test --match-path contracts/foundry/test/WalletSessionVault.t.sol` (local EVM only).
- Legacy Foundry suites to re-run: SessionVault*.t.sol.
- `node --test test/wallet-session/consumers.test.mjs` (inert fixture, no network).
- Then the preserved suites: test/sessions, session-api-auth, secrets, secrets-release, relay-session-forward, windows-node-session, cli-session, and the readonly quarantine/activation/queue-envelope references.
- SDK: `tsc --noEmit` in sdk/sessions. typed.ts does export `Grant` (checked by grep), but wallet.ts itself has never been type-checked.

## Remaining seams / activation blockers (not done)
- **SDK `client.ts` Session.call and grant/open:** these are not wired to `wallet.ts`. The new-version handle and selection still need to be plumbed into the quote/execute path. The relay `/open` route still builds a legacy Grant only, so a wallet-v1 session is opened by submitting `factory.openFor` / `openWithDepositFor` directly.
- **CLI session records:** they need to carry `version` and `owner` from sign-in. I did not verify that they do.
- **Host construction site:** where `createSessionApiAuth` is built (supervisor.js, outside the candidate), `walletPolicy` must be passed. The Windows node package must also ship `relay/wallet-session-policy.mjs`.
- **Hardcoded chain:** api-relay pins chainId 8453 to match its `base` client.
- **Release-path TOCTOU:** `secrets-release.mjs` re-runs `leaseHolder` (including custody) at release, which I confirmed by grep at line 523. Whether that runs after the asynchronous report verification needs root review.
- **Contract tests:** the Foundry tests marked `[ledger-assumption]` depend on rev-15d `create` setting rate == cap.
- **Not authorized and not done:** onboarding UI, gas funding, catalog publishing, old-fund/grant migration, any default or address change, deployment, and the production pin.
