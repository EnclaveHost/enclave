# wallet-owned-session-repair-r2: author report

Source only. I ran nothing: no tests, builds, compiles, RPC, signatures or deployments. All new and changed code is uncompiled and unexecuted. The prior size pass (executor 22039/22701, factory 2622/25809, library 10681/10713) applies **only to the prior source**. WalletSessionVault.sol changed and WalletSessionProfile.sol is new, so that qualification is lost. Root has to recompile and re-measure. No author may activate this.

## 1. Discovery: what created the row (`relay/wallet-session-policy.mjs`)
There is no factory list, operator allowlist or `inactive` state any more. `WALLET_SESSIONS_PINS` is now deny-only and optional. Each decision is made at one head block. Chain id and head hash are re-read at the end, and a reorg or chain switch throws.

1. **Created log.** The resolver reads the ledger's own `Created(id)` logs over the full range `[fromBlock(0), head]` and requires exactly one. It then checks:
   - the canonical block hash,
   - the receipt (success, same block, same log at the same index).
2. **Create vs import, from the ledger's own log order.**
   - `create()` emits `Created`, then `RunnerRateSet(id)` at logIndex+1 (EnclaveDeployments 728 then 696).
   - `importDeployments` emits `Created` with the imported `d.owner` (1507) and never `RunnerRateSet`.
   - So `Created.owner == wallet` proves nothing on its own.
3. **Create, by creator type.**
   - **Creator with no code at that block:** it must also be `receipt.from`, or be an EIP-7702 EOA. The result is `legacy-unbound` (positive evidence).
   - **Creator with code:** it must pass `verifyVault`, in this order:
     1. it is an EIP-1167 clone;
     2. the implementation's bytes match the reviewed artifact;
     3. its immutable `factory`'s bytes match the reviewed artifact, and the factory names that implementation and ledger;
     4. `CREATE(factory,1) == profile` and `CREATE(factory,2) == implementation`;
     5. the profile and the linked library bytes match their artifacts, and the library's self-address equals its address;
     6. `CREATE2(factory, owner, clone) == vault`.

     Then, in the same receipt, the vault's `Bound(id)`, the factory's `Bound(id, vault, owner)` and the transfer vault→owner must all be present. `factory.creatorOf(id)` and `isVault` must agree. The vault's ledger must be this ledger.
   - **Vault of the existing legacy factories** (`isLegacyVault`, the existing legacy config): `legacy-unbound`.
   - **Anything else:** `invalid`, which is refused.
4. **Import.** The resolver searches the full range, with no address filter, for `Bound(id)` from any reviewed vault.
   - Verified ancestry → `invalid` (imported wallet-session policy is unsupported).
   - No ancestry → `legacy-unbound`.
   - With no manifest, any `Bound(id)` emitter → `invalid`.
5. **Caching.** Results are cached only together with the birth block hash and every code hash, and are re-validated on each decision. Results for the immutable vault identity are re-validated by code hash.

**Code identity** (`relay/wallet-session-manifest.mjs`):
- Matching uses the exact length, plus keccak over the bytes with only solc's own `immutableReferences`, `linkReferences` and the library self-address ranges zeroed.
- Ranges are bounded and must not overlap. Address immutables must be zero-padded words.
- `relay/wallet-session-protocol.mjs` is a placeholder (**null, NOT generated**). With it null, no vault verifies, so every contract-created row is refused. **This is an activation blocker.**
- `tools/build-wallet-session-manifest.mjs` is the source-only builder that root runs after a qualified compile.

**Decision kinds:** `legacy-unbound | bound | detached | void | stale | invalid`.

## 2. Owner references and continuity
**Solidity.** The new `WalletSessionProfile.sol` returns exactly `deployments` and `appCatalog` (the only keys the unchanged SessionVaultLib reads, at lines 149 and 155) and zero for any other key.
- The factory snapshots the deployer's chosen book once at construction (profile = nonce 1, implementation = nonce 2).
- The vault's `book` immutable is now that profile, so every library call (create, feeAndApp, prepareFund, setShares, checkMaxRate) routes through it.
- `_ledger()` no longer consults any book. `LedgerMoved` is still declared but unused.
- `_ownerBinding` reads `ledger.get(id).owner`, the same ledger create and dispatch use. Other bindings are unchanged: the router, token and attestation immutables, the grant `ledger` field, the domain, revision-bound owner signatures, fees and catalog validation.

**Continuity (off-chain only).** The ledger has no ownership generation. The resolver reads the authenticated `DeploymentTransferred(id)` history after the birth transfer.
- If the row left the wallet and came back without a vault `PolicyChanged(id)` after the last transfer back, the result is `stale`. Secrets, relay sessions and host sessions all refuse it.
- **LIMITATION:** on-chain, `_bound` still lets a session act after a transfer back. The contract cannot enforce this. In addition, an owner operation signed before the transfer at the same revision can still be submitted later (it is bounded by `signBefore`).
- Legacy broad `setDelegate` authority still reaches new rows on-chain. I did not change it, and nothing is revoked automatically.

## 3. Consumers, action/environment
- **Secrets** (custody gate): `legacy-unbound` / `detached` / `void` → plain-wallet rule. `bound` STAGING → release. `bound` PROD → only an exact `contentHash(appRef, configCid)` approval. `stale` / `invalid` / unreadable → refuse or 503.
- **Sessions:**
  - A wallet-v1 session acts only on rows its own vault bound (env ∩ session envs, current app in `apps[]`).
  - A legacy session acts on a wallet-held row only when the result is `legacy-unbound`, `detached` or `void` (`legacySessionMayAct`).
  - **A missing resolver now refuses** in the custody gate, `sessionRowRefusal` and the host `refusal`. A default of null no longer means "plain wallet". This is an intended behaviour change: legacy suites that build these without a resolver will need one added.
- **On-chain table:** unchanged from r1, except that foreign-book changes no longer have any effect.

## 4. Final secret checks
- **secrets-release** (`handleRelease`):
  - `leaseHolder` now returns the `custodyDecision` policy key.
  - After evidence verification, it re-reads `custodyStateFor` (which must equal the earlier value).
  - Its last await is the full `leaseHolder` on a freshly confirmed row. This requires the same row key (id/owner/runner/appRef/configCid/active/isPublic/shares) and an **identical policy key**.
  - After that, `envOf`, seal and sign run synchronously.
- **secrets.js:** `custodyHeldOf` moved before the policy decision. The decision runs on a freshly re-read, lease-held row and is the last await before `readSecrets`.
- **Shield:** compares the first and final `custodyDecision` keys, then synchronously re-checks host name/mode/admission, Shield session and lease before `read(id)`.
- **Limit:** none of this is atomic with the chain. The owner's next transaction is observed, not locked.
- **Handler-level tests with paused async boundaries and secret read/seal/send spies are NOT written.** They remain a gap.

## 5. Constructors and packaging
- **Relay** (`relay/api-relay.js`): the resolver uses the client's configured chain (`WALLET_SESSIONS_CHAIN_ID` overrides it; no hardcoded 8453), the shipped manifest, the legacy-vault reader from the custody gate, and `WALLET_SESSIONS_FROM_BLOCK`. `custodyDecision` is passed to the secrets, release and Shield contexts.
- **Hosts:**
  - `supervisor.js` and `windows/node/agent.mjs` construct `createHostWalletPolicy` and pass `walletPolicy` to `createSessionApiAuth`.
  - If construction fails, they fall back to `refusingWalletPolicy`, which answers 503 and never bypasses.
  - `host.mjs` row inputs are unchanged from r1, which passes appRef/configCid. I did not re-verify that.
- **Shipping fix:** `windows/node/deploy-files.mjs` refuses bare imports outside `windows/node`, and the bundle has no `node_modules` under `relay/`. That means r1's `viem` import in the relay module could not have resolved on Windows.
  - The shared modules now have no bare imports. viem is injected through `useViem` by `relay/sessions.mjs` and `windows/node/session-api-auth.mjs`.
  - The stage-bundle import closure follows the static and dynamic imports, so `stage-bundle.sh` needed no change.
  - The Dockerfile COPYs the three relay modules.

## 6. SDK / CLI
**Done:**
- `wallet.ts` is exported from `index.ts`, and so from node/browser.
- `SessionHandle.version/deployment`.
- `Session.call` signs in the wallet domain for wallet-v1, adds `version`/`factory`/`ledger` to `/quote` and `/execute`, and refuses publish. Legacy handles are unchanged.
- `verifyWalletDeployment`: chain, code, PROTOCOL, ledger, the profile as CREATE(f,1) naming that ledger, and the CREATE2 vault.
- `openWalletSession`: grant and deposit against the wallet digest, POST `/open {version, factory, ...}`, and a vault/sid check.
- `completeSession` stores the verified version and deployment.
- Unknown-outcome execute is not retried.

**NOT done:**
- The relay `/open`, `/quote` and `/execute` handlers do not yet branch on `version` (r1's `/open` still builds a legacy Grant).
- The CLI does not yet select the version from the stored handle or display the actual owner after create.
- No SDK build or tsc.
- The shipped dist and sitevendor are untouched.

## 7. Tests: 7 + 3 assertion mapping
- `consumers.test.mjs` (7 authored) and `root-discovery.test.mjs` (the same 7 plus 3 root cases) keep **every assertion body unchanged**.
- The visible fixture diff, in both files:
  - `VAULT` was `A(0xa17)` and is now `P.vaultFor(WALLET)` (the CREATE2 derivation).
  - `FACTORY_CODE` was `"0x60016002"` and is now the synthetic factory template.
  - `getCode` now reads a code map.
  - `P.install` adds `getBlock`, `getLogs` and `getTransactionReceipt`.
  - Births are registered: ID by VAULT's create, ID_LEGACY by WALLET's own create.
  - The `resolver()` helper now passes `manifest: P.manifest`.
- Expected outcomes (none executed):
  - ROOT1: empty pins, PROD unapproved → refused.
  - ROOT2: `creatorOf` returns zero → invalid → refused.
  - ROOT3: chain 1 → `/wrong chain/`.
- New file `discovery-r2.test.mjs` adds 11 independent cases: no manifest, spoofed import ancestry and forged `Bound`, misattributed and unknown creators, legacy-vault creator, reorgs and chain switch, stale and redecided continuity, policy-key change, wrong-ledger `factoryOfVault`, no-resolver refusal, constructors, and packaging.
- **Solidity:** `test_ledgerMovedInBookRefusesEverything` is kept unchanged and now **fails by design**. It is replaced by `test_r2_foreignBookChangeHasNoEffect` and `test_r2_wrongLocalLedgerBindingRefused`.
- All synthetic code is fixture-only and is not product bytecode.

## Root's minimal next steps
1. Compile the product (`forge build --sizes` limits) and the two r2 Solidity tests.
2. `node --test test/wallet-session/*.test.mjs` and the preserved suites (expect no-resolver fixture updates).
3. `tsc --noEmit` in sdk/sessions.
4. Generate the manifest with the builder.
5. Wire the relay `/open` wallet-v1 route and the CLI.
6. Write handler-level secret spy tests.
