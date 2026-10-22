# Passkey account parity in the independent dashboard: owner operations, funding, Manage, the deploy dialog

Browser/identity workstream, round 2 (2026-10-19). Paths below are relative to `work/enclave` unless absolute.

Constraints held:
- No commit, staging, production, SSH, Wine, GUI or user window.
- No real key or transaction: every key was generated fresh for a local anvil chain. Base was read only (the fork upstream
  and code copies at the pinned contracts).
- No new contract, no Enclave bundler/paymaster/relay.
- Not edited: `network/management-*`, supervisor, CLI, Windows, custody, `sdk/`.
- The management bundle was not rebuilt.
- Interface status is updated in `work/passkey-dashboard-interface.txt`.
- The source inventory is `work/browser-final-source-inventory.json`.

## Result in one paragraph

With a Safe passkey account selected as the dashboard identity, the account approves and pays for everything, and the
connected wallet only sends transactions and pays gas. That was exercised through the dashboard UI in headless Chromium
with Chrome's virtual authenticator:
- **Base fork** (the pinned deployed Safe v1.4.1, passkey signer v0.2.1, 4337 module and USDC v2.2 code): session start,
  add budget, extend, end all; the Environment tab; Promote via the Version tab; the Apps quick-deploy dialog (fee-free
  app through the account's session; paid app and prepare-only record by the Safe itself); ETH funding by the Safe; row
  Top up from the account; the Safe's ledger delegation against the deployed rev-16d ledger.
- **Local rig** (pinned Safe code copied from Base, real management gateway): Manage.

The test also checks the gas payer end to end: it owns no record, funded nothing, holds no USDC, and every transaction it
sent went to the account's Safe or vault, or to the ledger carrying the Safe's own USDC authorization.

**Current status:** see `work/claude-account-first-result.md`. The items this round left open (account-first, ETH for
vault-held records, the Startup tab on Safe-held records, the EOA suite beyond test 14) were closed in round 3.

## 1. What changed

### Defects found and fixed (account-specific)

| defect | effect before | fix |
|---|---|---|
| `payForRuntime` (row Top up, deploy funding) signed and paid from the connected wallet. | Under an account identity the gas payer funded the account's records with its own USDC/ETH, and the refundable escrow was not the owner's. | `site/js/core/fund.js:108` sends every ledger funding under an account to `sessions.accountFund` (`site/js/core/sessions.js:957`): vault-held records from the session budget; Safe-held records from the Safe's USDC (ERC-1271 authorization) or ETH (`execTransaction → fundEth`). |
| Manage required the session owner to be the connected wallet. | Under a Safe identity, Manage always refused ("belongs to another wallet"). | `site/js/core/independent-management.js:153`: the session must belong to the acting owner (the wallet, or the verified Safe). The wallet-mode wording is unchanged. |
| The session controls said "Wallet session" and never repainted on an identity change. | After a switch they could show the other identity's session. | `site/js/core/independent-ui.js:145`: "Account session" / "Wallet session", repainted on `enclave:identity` and `enclave:session`; nothing is shown while the account is pending or refused. |
| **Start a session** under an account was refused ("sign in from the panel"). | No session start from the session controls. | `startAccountSession` (`sessions.js:943`): the passkeys approve and the wallet submits. The panel's Sign in uses the same `prepareAccountSession` (`sessions.js:915`). |
| The quick-deploy dialog said "Fund it from your wallet", showed the wallet's USDC, and quoted "free for you" against the wallet. | Wrong owner and payer shown before signing. | `site/js/pages/apps.js:481`: under an account it says the account owns and funds it, shows the session budget and the account's USDC, and quotes against the acting owner. An unverified account blocks Deploy with the reason. |
| `sessions.js` kept a cached session across identity changes when the dashboard panel was not mounted. | A stale session could serve the next identity. | `identityChanged` (`sessions.js:84`) runs on every `enclave:identity`. |

### Capabilities solved in the browser with existing owner authority (no new contract)

A deployed Safe is a full ledger owner: through `execTransaction`, with its passkeys' approval, it can create records and
fund them itself. `accountCreate` (`site/js/pages/deploy.js:363`) uses that wherever a session cannot act. Each item was
verified on the Base fork through the UI:

| capability | path under an account identity |
|---|---|
| Paid app | The Safe creates the record (`create` with the publisher fee snapshot) and funds it with a USDC authorization it signs. |
| Prepare-only (owner-committed startup) | The Safe creates it with the prepare-only envelope, unfunded. |
| ETH funding | The Safe creates the record and pays `fundEth` from its own ETH. |
| No account session | The Safe creates it (one passkey approval). |
| Environment (adopt, staging ↔ production, release) | New **Environment** tab on vault-held rows (`site/components/deployments/deployments.js:3925`). It goes through `sessions.ownerOp`: under an account, a signed operation; under the wallet, its transaction. It also fills a wallet-mode gap: there was no UI for these. |
| Manage on Safe-held records | The Manage panel offers "Allow (approve with passkey)" (`deployments.js:875`): `setAccountDelegation` (`sessions.js:997`) has the Safe call the ledger's `setDelegate` for its vault. |

The rule throughout: a ledger call is never sent as the wallet under an account identity. It goes through the session,
or as a Safe transaction simulated at an agreed block first (`safeExecute`, `sessions.js:893`), or it is refused.

## 2. Tests

All Chromium jobs ran one at a time, each in its own transient systemd scope:
- the scope set `MemoryMax=1280M` and `MemorySwapMax=0` (verified: `memory.swap.max` = 0);
- inside it, `test/helpers/memory-guard.mjs` ran with `--max-rss-mib 1280 --floor-available-mib 16384`;
- each started with at least 18 GiB available (18.2–19.8 GiB at start).

The guard now also kills anything a crashed job leaves behind (its process group and every descendant last seen). That
was added after one aborted run left my fork anvil running; I killed it (pid 3616994).

### `test/site-independent-passkey-ui.test.mjs`: 3/3, peak 1083 MiB

Headless Chromium, the virtual authenticator, and an anvil fork of Base at block 52,836,800 (read-only upstream). The
repository's ledger, catalog and pinned session factory are deployed locally, plus a test-only ETH/USD feed (the rig's
feed source).
1. Panel: passkey, recovery key, the Safe deployed by the gas payer, sign-in.
2. The account as identity: its rows only, a create and row actions as the account, a refused stale description, back to
   the wallet.
3. New, all under the Safe identity through the UI:
   - session controls: Add budget ($3, from the Safe's USDC), Extend, End all sessions (`revokeAll`, signed);
   - the **Apps quick-deploy dialog** itself (`/apps?app=…` → Deploy):
     - a fee-free app via the session (vault-held, `Funded.from` = vault);
     - a paid app via the Safe (Safe-held, `Funded.from` = Safe, Safe USDC −$2);
     - prepare-only via the Safe (its configCid is the prepare-only envelope);
   - Environment → production; Version tab → Promote (the vault records the promotion; appRef is the new version);
   - ETH by the Safe;
   - row Top up: the Safe-held record from the Safe's USDC, the vault-held record from the session budget;
   - the Safe's `setDelegate` on the deployed rev-16d ledger `0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B` on the fork
     (the repository's ledger source has no `setDelegate`);
   - after switching to the wallet, the wallet sees no account session.

   Then, for every block of the test:
   - no record is owned by the payer;
   - no `Funded` event is from the payer;
   - the payer holds 0 USDC;
   - each of its transactions went to the Safe or vault, or was `fundWithAuthorization` with `from` = the Safe.

   The paid app is published by a separate key. The payer as publisher received the fee cut in one run, which was
   correct behaviour but blurred the check.

Runs this round:
- 1035 MiB: a method-name collision (`_env`), fixed;
- 923 MiB: a driver catalog CID reuse, fixed;
- 1117 MiB: a session read before re-verification, by design, so the test now waits;
- 1108 MiB: the payer was the publisher (above);
- **1106 MiB: pass**;
- 1085 MiB: delegation step evaluated before re-verification (correctly refused), so the test now waits;
- 920 MiB: the driver's own V8 heap at 160 MB aborted after importing the SDK; the checks moved into the page and the heap
  cap went to 224 MB;
- **1083 MiB: 3/3 pass**.

Every rerun followed a specific diagnosed cause.

### `test/site-independent-management.test.mjs`: 10/10, peak 1194 MiB

The real management gateway (current working-tree source), the supervisor stand-in re-verifying with
`windows/node/session-api-auth.mjs`, the test CA, DNS rules, and the held vendored `site/vendor/management.js`. The 8
existing tests pass unchanged.

New test 9:
- The pinned Safe passkey code is copied from Base onto the rig chain; each code hash is checked against its pin. Plain
  anvil 1.7.1 verifies P-256 at 0x100 natively.
- The account is created and deployed through the panel, selected, and its session started from the session controls
  ("Approve with passkey").
- **Manage status on a vault-held record succeeds**, signed by the account's session.
- After releasing a record to the Safe (Environment tab, signed), Manage is refused and the host does nothing. The panel
  says this ledger cannot let a session vault act for it: the rig ledger is HEAD source, without `setDelegate`.
- Back on the wallet identity, Manage on the account's record is refused before any request.

### `test/site-independent-browser.test.mjs` (wallet/EOA mode, unchanged): stopped at 1284 MiB

The guard stopped it at 1284 MiB > 1280 MiB during test 15 (custom names), with at least 16,886 MiB available.

Tests 1–14 passed, covering every wallet-mode path this round touched:
- wallet session;
- owner operations (start, add budget, extend, promote, end all);
- listing, quorum and resumable listing;
- the quick-deploy dialog;
- ETH funding;
- startup commit;
- host choice.

Tests 15–18 did not run (custom names, Startup tier, Connect, the "nothing reached Enclave" check). Not retried, per
the allocation rule. Peak breakdown: the rig's in-process servers in the Node driver, anvil, and an unmodified (not
lean) Chromium. The lean flags used elsewhere were not applied to this file this round. A rerun needs either about 1.4
GiB or those flags.

### Node (each under a 512 MiB guard)

| suite | result |
|---|---|
| identity | 7/7 |
| **account-sessions (new)** | **5/5**: another Safe's session never serves; pending/refused/unknown sends refused without touching the wallet; an identity change drops the cache |
| passkey-account | 8/8 (aa vendor bundle reproducible) |
| owner-signature | 5/5 |
| account-providers | 6/6 |
| names | 4/4 |
| profile | 6/6 |
| bundle | 2/2 (sessions vendor = fresh build of the current SDK source) |
| management-unit | 27/28 (test 1 = held bundle, below) |
| regressions | all pass: api-base-binding 11, config-override-plan 8, dashboard-host-auth 11, dashboard-tls-status 11, deploy-zero-fund 2, deployment-move 21, models-read-only 5, pay-domain-pinning 5, pricing 64, runlog-retry 12, site-ledger-calls 7, site-list-failure 12, site-session-auth 18, admin-console 43, catalog-confirmed-write 11, featured-group 11, publish-cid-verify 7, publish-prefill-config 5 |

Hosted mode is untouched: `identity.currentIdentity()` is always the wallet outside independent mode, and the hosted
suites pass.

## 3. Remaining capability gaps: superseded

The gap table that stood here is superseded by `work/claude-account-first-result.md` (round 3), which is the current
status. Since this report:
- **Closed:**
  - account-first with no wallet (shared-signer creation through the owner's own bundler, the account's own ETH or an
    owner-named paymaster, every action as a user operation);
  - ETH funding of vault-held records;
  - the Startup tab on Safe-held records.
- **Still open** (listed in the current report): no-wallet Startup publishing (the adapters accept EIP-191 upload
  signatures only), `setDelegate` missing from the ledger source, the held management bundle, and the legacy credit
  vault.

## 4. Interfaces the move worker needs (no `network/management-*` edit made here)

- **The browser never moves under independent mode.** The Pin/move button is hosted-only (`!INDEPENDENT_MODE`), so
  `site/js/core/deployment-move.js` does not run under an account identity.
- **An account's records are held by the Safe itself or by its session vault.** Under an account, host-side move/release
  routes must:
  1. accept `EnclaveSession` signatures from a session vault whose `owner()` is a contract. Status already works this
     way through the current gateway and supervisor (test 9 above);
  2. for records the owner holds directly, rely on the ledger delegation (`setDelegate`, deployed rev 16d), never on
     `msg.sender`/ECDSA from an EOA owner;
  3. if an owner signature is ever required, ask for EIP-712 typed data checked with ERC-1271 at an agreed block. A Safe
     produces no `personal_sign`/EIP-191 ECDSA.
- **The browser offers these entry points for such flows:**
  - `sessions.safeExecute({to, data, value})`: a passkey-approved Safe call, simulated first, gas-payer submitted;
  - `passkeySafeOwnerSigner` (EIP-712 → Safe ERC-1271 signature);
  - `identity.actingOwner()`;
  - `sessions.currentSession()`, which is owner-scoped.
- **After the move-fix review is committed:** rebuild with `node scripts/build-management-vendor.mjs`, then re-run
  `test/site-independent-management-unit.test.mjs` and `test/site-independent-management.test.mjs`.

## 5. Management bundle (held)

Not rebuilt. `site/vendor/management.js` (sha256 768f7df6…) still matches its manifest. Two of its recorded sources
differ from the working tree:
- `network/management-outcome.mjs`: recorded fdc9f031…, now fea57034…;
- `network/management-routes.mjs`: recorded 28712a29…, now 0a472395….

Both are uncommitted move-fix changes under review 30692. That is the only management-unit failure. The browser test
passes with the held bundle against the current gateway source.

## 6. Source closure (`work/browser-final-source-inventory.json`)

The inventory covers 112 files at HEAD `2eabb9e3`: 55 untracked, 30 modified, 27 clean. Each entry has its working
sha256, git blob, HEAD blob, attribution, the vendor provenance and the toolchain versions (viem 2.53.1, ox 0.14.29,
esbuild 0.28.1, solc 0.8.35, Playwright 1.61.1, Node 22.23.3).

Dirty cross-component dependencies that must close together:
1. **`sdk/sessions/src/client.ts` and `dist/*` (uncommitted).** They add the relay-free owner operations (incl. "signed"
   mode) and `prepareTopUpFromWallet`. Independent mode uses them for every owner operation and top-up, wallet and
   account alike, and `site/vendor/sessions.js` is built from them (bundle test passes).
2. **The independent browser mode itself is untracked:** `site/js/core/independent*.js`, `quorum.js`, `identity.js`,
   `passkey-account.js`, `account-*.js`, `owner-signature.js`, `grant-check.js`, `startup-package.js`, its tests and
   `site/vendor/aa.js`.
3. **Held management sources** (above).
4. **Browser files with unestablished authorship:** `site/js/core/chain.js`, `addressbook.js`, `catalog.js`,
   `enclave-network.js`, `site/deploy.sh`. They are dirty, but this workstream's reports don't list them, so their owner
   must be confirmed before a browser-only commit.
5. **Contract/deployment divergence:** `setDelegate` exists only in the deployed rev-16d ledger.

## 7. Files changed this round

- **Source:**
  - `site/js/core/sessions.js`, `fund.js`, `independent-ui.js`, `independent-management.js`, `account-ui.js`
  - `site/js/pages/deploy.js`, `apps.js`
  - `site/components/deployments/deployments.js`
- **Tests:**
  - `test/site-independent-passkey-ui.test.mjs`, `test/site-independent-management.test.mjs`
  - new: `test/site-independent-account-sessions.test.mjs`
- **Helpers:** `test/helpers/fork-deploy.mjs` (test feed), `test/helpers/memory-guard.mjs` (leftover reaping)
- **Docs:** `docs/network/independent-dashboard.md`
- **Work files:** `work/passkey-dashboard-interface.txt`, this report, `work/browser-final-source-inventory.json`

No processes of mine remain. Other workers' processes were left alone: an `anvil` under `test/move-release-durable.test.mjs`, and old
chain-31337 anvils.

---

# Earlier report (same file, first slice, written 2026-10-19 19:14)

# Passkey parity without an Enclave account authority: audit, plan, first slice

Workspace: `work/enclave`.
- Nothing was committed, deployed, published or activated. No production, SSH, chain write, Wine or GUI.
- No existing contract was modified; no new contract was written (design only).
- No CLI, Go, Windows, custody or `network/*` management/core file was edited.
- Memory stayed at 17.8–18.4 GiB available.
- No Chromium was run. One regression file, `test/sessions-owner-ops.test.mjs`, runs its own short-lived anvil (chain
  31337); it exited cleanly, and no anvil process from this task remains.

The plan is in `/home/steven/Documents/Codex/2026-10-18/wo/work/passkey-independence-interface.txt`: the audit (section
A), the target protocol per feature (B), what's built and planned (C) and the activation gates (D).

## What the audit found (primary sources)

1. **The hosted account is Enclave authority throughout.**
   - `relay/auth.js`: passkeys under RP `enclave.host` and relay-minted JWTs.
   - The relay also runs the device flow (`relay/auth.js` `/v1/account/device/*`).
   - `relay/sso.js`: EST1 claims signed by an Enclave key.
   - `relay/billing.js`: Stripe merchant and provisioner.
   - `relay/vaultsvc.js`: gas paid by the relay.
2. **The deployed `EnclaveCreditVault` cannot become independent.**
   - It does use RIP-7212 WebAuthn, with the type/challenge/origin prefix and UP.
   - But its origin is immutably `https://enclave.host`, outflows go only to Enclave, and its `controlDeployment`
     allowlist has no `transferDeployment`.
   - `recoveryAdmin` is the company.
   - Existing credit-vault customers therefore stay hosted, and must sign on an enclave.host page. The plan says so
     instead of hiding it.
3. **The pinned `SessionVault`/`PinnedSessionVaultFactory` already support a contract-wallet owner end to end.**
   - Grant signatures (`_checkGrantAuth` → `_ownerSigValid`, which tries ECDSA, then ERC-1271 when the owner has
     code).
   - Owner operations: a direct call from the account, or ERC-1271.
   - USDC EIP-3009 deposits with a `bytes` signature.
   - Session keys are P-256 via RIP-7212.
   - The one gap: no ERC-6492, so the owner account must be deployed.
4. **`EnclaveDeployments` is EOA-agnostic** (the owner is whoever called `create`, or the transfer target).
5. **ERC-4337 v0.8 and EIP-7702 `Simple7702Account` are already the repo's standards** (`EnclaveHostPaymaster`, for
   hosts only).
6. **WebAuthn invariants.** I took the canonical list from the locally installed `ox` 0.14.29
   (`webauthn/Authentication.ts` `verify`), alongside `@simplewebauthn/server` in the relay:
   - `authenticatorData` ≥ 37 bytes; rpIdHash = `sha256(rpId)`;
   - UP set, and UV when required; BE=0 implies BS=0;
   - `type` is `webauthn.get`; the challenge and origin match;
   - P-256 over `authData ‖ sha256(clientDataJSON)`.

   No Solidity WebAuthn library exists locally, so I wrote no new on-chain verifier.
7. **The RP-domain dependency is real and stated.** A browser passkey works only on its RP domain. Independence
   therefore means:
   - an RP the owner chooses;
   - keys under more than one RP;
   - FIDO2 security keys over CTAP2 (usable with any rpId, no website);
   - guardian recovery.

   Moving the RP away from Enclave is not enough on its own.

## The plan (interface file, section B)

| Feature | Independent form | Status |
| --- | --- | --- |
| Passkey identity | Owner-controlled passkey smart account, preferably an existing audited, deployed one: Safe + passkey module, Coinbase Smart Wallet, or an ERC-7579 WebAuthn validator. Must pass R1–R5: replay-safe 1271, the WebAuthn invariants, owner-only signer management, 4337 execution, verified bytecode. | PLAN; candidate addresses and versions to be verified at activation |
| Multi-device and recovery | Several passkeys under several RPs, security keys, an M-of-N guardian threshold with a cancellable timelock. No company recovery admin. | PLAN; a Safe owner gives threshold recovery today through the slice |
| Gas sponsorship | Owner-selected ERC-4337 bundler and paymaster: a USDC ERC-20 paymaster, or a provider-verified or self-funded one. Configured in the profile; no Enclave default. Relay sponsorship stays a hosted opt-in. | PLAN; vendor lists and fees need approval later |
| Card/fiat funding | A third-party on-ramp the owner picks delivers USDC to the account (external trust). Enclave's Stripe checkout stays hosted; a variant provisioning into the user's account is a billing-owner change. | PLAN + HOSTED |
| CLI device flow | Exists: `session new --owner` → `/grant` → `session open`. Planned: a QR to the owner-chosen dashboard, a passkey-account 1271 approval, CLI polling of agreed chain state. No issuer key. | PARTLY EXISTS |
| SSO for tenant apps | The app verifies the user's own SIWE (ECDSA, 1271 or 6492) or an EnclaveSession header against chain, instead of EST1. | PLAN (app SDK owner) |
| Account deployments | Chain listing over `[account, vaultFor(account)]`. | EXISTS |
| New Enclave account contract | Only if no candidate passes R1–R5. Isolated draft (`contracts/proposals/PasskeyAccount.sol`) built on the reviewed `EnclaveCreditVault._verify`, made stricter (per-key rpIdHash and owner-chosen origin, UV, low-s, BE/BS, replay-safe 1271, guardian timelock, 4337 v0.8). Separate audit before any deployment. | DESIGN ONLY, not written |

## Implemented slice: contract-account (ERC-1271) session owners in the browser

It uses only existing deployed contracts and closes one concrete gap: the browser could pass a contract owner's
signature through, but never checked it before spending gas or handing it to the CLI.

- **`site/js/core/owner-signature.js` (new):**
  - `kindOfCode` / `ownerAccountKind`: EOA, EIP-7702-delegated EOA (`0xef0100‖delegate`) or contract account, read from
    code at an agreed block.
  - `isErc6492` refuses counterfactual signatures up front ("deploy the account first"), since `SessionVault` has no
    6492.
  - `verifyOwnerSubmission({prep, owner, signatures})` simulates the exact factory call (`openFor` /
    `openWithDepositFor`) with `eth_call` at a quorum-agreed block:
    - the vault's own `_ownerSigValid` (ECDSA or ERC-1271), and USDC's EIP-3009 check, decide;
    - no signature scheme is re-implemented;
    - an agreed revert is refused with wording that differs for EOA and contract (the account's own signers or
      threshold may need to approve);
    - disagreement is a "chain" refusal.
  - `recordingSigner` captures the signatures the SDK asks for, so the exact ones are checked.
- **`site/js/core/sessions.js` (`startDirectSession`):** dashboard sign-in records the owner's signatures and checks the
  prepared call before `submitPrepared`. On refusal the new session key is removed.
- **`site/js/pages/grant.js` (independent `/grant`, CLI pending grants):**
  - shows the owner kind;
  - "approve and open" checks before `sendTx`;
  - "sign only" simulates the very `openFor` the CLI will submit, and hands over a signature only once the vault
    accepts it.
- **What works with this (any deployed account whose injected wallet answers `eth_signTypedData_v4`):**
  - a Safe as session owner (its M-of-N signers are the recovery);
  - an EIP-7702 account;
  - an existing passkey smart wallet.

  None of these needs an Enclave account.
- **Docs:**
  - `docs/network/independent-dashboard.md` (contract-account owners).
  - `docs/network/independent-name-routing.md`: the outdated "browser fixed key list refuses names" item is replaced.
    The browser verifier is done and vector-tested; the live activation limits are kept unchanged.

## Tests

- **`test/site-independent-owner-signature.test.mjs` (new): 5 pass.**
  - Owner kinds from code, including a malformed designator.
  - A 1271 signature rides the SDK's exact `openFor`, and the simulation is one agreed `eth_call` of exactly those
    bytes, with the owner's code read at the same block.
  - A funded grant records both signatures (grant and USDC authorization) and is checked in one `openWithDepositFor`
    simulation.
  - Refusals:
    - an agreed revert (EOA and contract wording);
    - no agreement;
    - an ERC-6492 signature, refused before any chain read;
    - malformed input.
  - Sign-in and `/grant` order: the check comes before submission and before the hand-over.
- **Mutations: 7 of 7 killed** (isolated `/tmp/mut-owner`, since removed):
  - 6492 not refused;
  - other bytes simulated;
  - revert treated as success;
  - 7702 designator read as a contract;
  - signatures dropped;
  - sign-in submitting before verifying;
  - `/grant` sign-only skipping the check.
- **Regressions (single job): 94 of 94.** The files: `site-independent-owner-signature`, `site-session-auth`,
  `site-independent-bundle`, `-management-unit`, `-names`, `-profile` and `-review`, `site-ledger-calls`,
  `vault-digest`, and `sessions-owner-ops` (anvil, real pinned vault).
- **Not tested (needs the browser + anvil allocation):** a real deployed 1271 account (a Safe, or a passkey smart
  wallet) opening a session through the dashboard and `/grant` on anvil. The simulation path is exercised with scripted
  agreed reads and the real SDK calldata only.

## What remains, and what needs approval later (no action now)

1. **Choose the passkey account implementation** (B1). Verify the Base deployment, source and audits against R1–R5. If
   none fits, review whether the C3 draft should be written.
2. **Approve the bundler, paymaster and on-ramp suggestion lists, and their fees/terms** (B4, B5). They are concrete
   choices for later; no Enclave-exclusive default.
3. **Next browser slices, each separately reviewable** (C2):
   - an account kind and recovery panel;
   - the profile's `aa` section (EntryPoint, bundlers, paymaster) via viem account-abstraction;
   - passkey account creation on an approved account;
   - the device-flow QR and chain polling.
4. **Owners elsewhere:**
   - the billing owner, for provisioning into a user's account;
   - the app SDK owner, for SIWE/1271 SSO;
   - the CLI owner, for the device-flow QR and the CTAP2 security-key path.
5. **Legacy credit-vault customers remain hosted.** Their deployments cannot move out on chain, and their passkey
   signatures must come from enclave.host.
6. **Activation tests:** Chromium virtual-authenticator registration and assertion against the selected account, and
   a /grant run with a deployed 1271 owner on anvil.

Passkey parity is **not** complete. The account contract choice, the AA transport, recovery, the device flow and SSO
remain planned. Only the foundation (contract-account owners checked by the contracts themselves) is built.
