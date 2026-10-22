# Account-first passkey parity in the independent dashboard: result (current status)

Browser/identity workstream, round 3 (2026-10-19). Repository: `work/enclave`. HEAD at the end was `abe86262`; the only
commit after `45801c22` touches Windows installer files and none of this component. This file is the CURRENT status: the
open items in `claude-passkey-parity-result.md` and `passkey-dashboard-interface.txt` were replaced by pointers here.

Constraints held:
- No commit, staging, production, SSH, Wine, GUI, wallet request or real key: all keys were generated fresh for local
  anvil chains, and Base was read only.
- No new repository contract. The paymaster in the tests is a test-only fixture compiled inside a test helper, like the
  existing test ETH/USD feed.
- Not edited: SDK, CLI, Windows, supervisor, `network/management-*`.
- The management bundle was not rebuilt.

## 1. Outcome

A passkey account now works in the independent dashboard **with no wallet at all**, and with a wallet as a gas payer
only.

| capability | status | evidence |
|---|---|---|
| Account creates itself (shared-signer passkey, atomic initializer) through the owner's bundler, paying with its own ETH | done | account-first test 1 (Chromium, no `window.ethereum`) |
| The same, with an owner-named ERC-7677 paymaster and NO ETH at the address | done | account-first test 5 |
| Sessions, the Apps quick-deploy dialog and row actions as user operations from the account | done | account-first test 2 |
| An unknown outcome: kept pending, blocks new operations without signing, never resent; then settled from the EntryPoint's own event | done | account-first test 3 |
| `/grant` Sign only (handed to a SEPARATE payer; checked with the CLI login helper's exact policy rule) and Approve and open through the bundler | done | account-first test 4 |
| ETH funding of a record the account's session vault holds | done | passkey-ui test 3, step 9a (`FundedEth.payer` = the Safe) |
| Startup tab on a record the Safe holds | done (with a wallet as uploader) | account-startup test |
| Wallet/EOA mode | unchanged | EOA suite 18/18, now including tests 15–18 |
| Manage under a Safe identity | unchanged | management 10/10 |

### The defects behind last round's 1/4

1. **`0xacfdb444` = `ExecutionFailed()` (Safe4337Module).**
   - The account's own call (`SessionVault.execute deploy.create`) ran out of gas inside the module.
   - The stand-in bundler's fixed `callGasLimit` was too low, and the page trusted it.
   - Fix (`site/js/core/account-transport.js`, `gasFor`): the page now measures the account's own call FROM the account
     at the agreed block (`eth_estimateGas` through the quorum reader, highest answer) plus the 4337 overhead, and uses
     the larger of that and the bundler's figure.
   - Regression check: test 2 runs with the bundler deliberately under-estimating. The unit test pins the floor and a
     refusal when the call cannot be measured.
2. **`independent-mode:/enclaves`.** The quick-deploy dialog fetched the hosted fleet table even in independent mode. It
   now never does (`site/js/pages/apps.js`): hosts, prices and heartbeats come from the pinned registry. Test 2 asserts
   no such fetch is attempted.
3. **`/grant` kept showing the previous request** when a second request link was opened in the same tab (a fragment-only
   navigation). The page now re-renders on `hashchange`, so a stale request is never approved under a new link.
4. **Not a product defect: test races.** The held-outcome and grant tests failed only because they depended on test 2.

### Login browser glue (`work/independent-login-browser.patch`)

- Reviewed, and applied cleanly: the base hashes matched exactly (sessions.js `736fadad…`, grant.js `c068f3be…`).
- One defect fixed: `grantOwner()` did not wait for a stored account to re-verify on page load, so `/grant` refused with
  "still being checked". It now awaits `ensureIdentity()`.
- Extended:
  - `grantOwner().ownGas`;
  - Approve and open without any wallet when the account pays its own gas.

## 2. What was built (browser source only)

- **`account-providers.js`:**
  - pins Safe v1.4.1 MultiSend `0x38869bf6…` and MultiSendCallOnly `0x9641d764…`. Their code hashes equal the
    safe-deployments `e9cc9798` published hash and the Base runtime at block 52,836,800 on two independent RPCs;
  - owner-chosen bundlers and paymasters may be `http://` only on loopback.
- **`passkey-account.js`:**
  - a shared-signer passkey owner (at most one per Safe, only at the pinned shared signer);
  - `safeInitializer` with `MultiSend[delegatecall enableModules(4337 module), delegatecall SharedSigner.configure(x, y,
    verifiers)]`, the shape of Safe's own `examples/4337-passkeys` at the pinned commit;
  - `creationOf`, `multiSendPack`, `estimationSignature`, `userOperationHash`, `toRpcUserOperation`, `bundlerRequest`;
  - `sendUserOperation` now reports `delivered: false` (every bundler refused: nothing pending) versus `"unknown"`
    (possibly received);
  - `verifyAccountProfile` checks a deployed account's configured shared key.
- **Shared signer, verified from its source at the pinned commit:**
  - `configure` is delegatecall-only (`NotDelegateCalled`);
  - the key is read from the calling Safe's own storage;
  - an unconfigured Safe fails closed;
  - user verification is required.
- **`identity.js`:** a shared passkey counts only with exactly its key configured in this Safe, and the module's
  `SUPPORTED_ENTRYPOINT()` must be the pinned EntryPoint v0.7.
- **`account-transport.js` (new):**
  - an explicit gas choice per account (no silent default once a transport exists);
  - the prefund check against the account's ETH plus its EntryPoint deposit, or the paymaster's deposit;
  - simulation of the exact call from the account, then the exact signed operation through `EntryPoint.handleOps` at an
    agreed block;
  - ERC-7677 paymaster data: stub data, then final data, and only the named paymaster is accepted;
  - a pending record kept before sending;
  - the outcome read from `UserOperationEvent`/`UserOperationRevertReason` at agreed blocks;
  - `checkPending` and `discardPending`; never resent.
- **`quorum.js`:** the base fee on snapshots, `call` with `from`/`value`, `balance`, `estimateGas` (highest answer), and
  the transaction hash on logs.
- **`sessions.js`:**
  - every submission under an account goes through the wallet or the account's bundler, as chosen;
  - `safeExecute` becomes a single user operation in bundler mode;
  - "Start a session" works without a wallet;
  - ETH for vault-held records via `fundEth` from the Safe;
  - `grantOwner`.
- **`account-ui.js`:**
  - the account-first checkbox, the Gas fieldset (with the agreed balance), "Check the pending operation", and
    self-deployment through the bundler (creating the other passkeys' signers in the same operation);
  - "Send from the account through my bundler" in call offers;
  - the identity bar and status lines say who paid (the account, or "your paymaster 0x…").
- **Other pages and panels:**
  - `deployments.js`: a wallet is asked for only when someone must pay gas and the account does not; Startup uploads
    are signed by the wallet as uploader only, and the account commits; passkey wording on Suspend/Resume.
  - `wallet.js`: `ensureBaseChain` is a no-op with no wallet when the account pays its own gas.
  - `deploy.js`: no wallet prompt then.
  - `dashboard.js`: no bounce without a wallet in independent mode.
  - `grant.js`: the `hashchange` re-render.

## 3. Tests: actual results

All browser jobs ran serially, each in its own systemd scope (`MemoryMax=1408M`, `MemorySwapMax=0`), with
`test/helpers/memory-guard.mjs` (`--max-rss-mib 1408 --floor-available-mib 16384`). Each started with at least 18 GiB
available (18.4–19.5 GiB). No process or temp directory of mine was left behind.

| test | result | exit | peak tree RSS | min host available |
|---|---|---|---|---|
| `site-independent-account-first` (no wallet; Base fork; real EntryPoint v0.7; local test bundler; test paymaster) | **5/5** | 0 | 1116 MiB | 17737 MiB |
| `site-independent-account-startup` (rig, storage adapters, pinned Safe code copied from Base) | **1/1** | 0 | 879 MiB | 17228 MiB |
| `site-independent-passkey-ui` (Base fork) | **3/3** | 0 | 961 MiB | 17578 MiB |
| `site-independent-management` (real gateway source; Safe identity) | **10/10** | 0 | 1192 MiB | 16872 MiB |
| `site-independent-browser` (EOA; lean flags added) | **18/18** | 0 | 1205 MiB | 16826 MiB |
| `site-independent-passkey-aa` (Node, Base fork; new test 7: atomic shared-signer initializer, front-run deploys exactly the owner's key, `configure` not directly callable, self-creation paid with own ETH, ERC-1271 through the shared signer) | **7/7** | 0 | 374 MiB | 18296 MiB |

Node suites, each under a 512 MiB guard:

| suite | result |
|---|---|
| identity (+ EntryPoint and shared-key cases) | 8/8 |
| account-sessions | 5/5 |
| **account-transport (new)** | **9/9** |
| passkey-account (incl. delivery semantics) | 8/8 |
| owner-signature | 5/5 |
| account-providers | 6/6 |
| names | 4/4 |
| profile | 6/6 |
| quorum | 8/8 |
| bundle | 2/2 |
| management-unit | 27/28 (below) |
| regressions | api-base-binding 11, config-override-plan 8, dashboard-host-auth 11, dashboard-tls-status 11, deploy-zero-fund 2, deployment-move 21, models-read-only 5, pay-domain-pinning 5, pricing 64, runlog-retry 12, site-ledger-calls 7, site-list-failure 12, site-session-auth 18, admin-console 43, catalog-confirmed-write 11, featured-group 11, publish-cid-verify 7, publish-prefill-config 5 |

**`deployment-move`** briefly failed 12/21. My wallet-guard swap had reached the hosted-only `_doMove`, which that test
evaluates in isolation. The original guard is restored there, and it passes 21/21.

**Runs this round that failed, with their causes:**
1. Account-first, two runs after the `0xacfdb444` diagnosis:
   - 3/4, the fragment-only `/grant` navigation (fixed);
   - 4/5, the panel starting closed after "Forget" (a test fix; test 5 then passed alone).
2. Passkey-ui 2/3: the dialog's balance read before it loaded (a test wait).
3. The final runs of every file are the table above.

## 4. Tested source (sha256, first 16 hex)

| group | files |
|---|---|
| core | `account-transport.js` d5ed5f5aee023d60 · `passkey-account.js` 86c9de90ae7bc84a · `account-providers.js` 06327b07cccd22b5 · `identity.js` e4d680bba9937ff1 · `quorum.js` 7d081b6e6db2635a · `sessions.js` 0d749118e5e6c2f0 · `account-ui.js` b42a5ac457c50e58 · `wallet.js` 4eb8217fbd67acf9 · `fund.js` d6271b36dd84ad98 · `independent-ui.js` 743f4acf1c7bbc36 · `independent-management.js` 60440a1a99700fb3 |
| pages and panel | `grant.js` 8f2c620a9d58c851 · `apps.js` b4971f17d355b234 · `deploy.js` 456b2fa3265ca178 · `dashboard.js` 1356b5c8b80d64cd · `components/deployments/deployments.js` e8ddb1dc7979803d |
| tests | `account-first` 26586cf417f5c94a · `account-startup` f18d2ee7efbb6b96 · `account-transport` 99e11e9556c8e2f7 · `passkey-ui` d3e9acc5d7564764 · `management` 8528f8e23a8f4960 · `browser` f7d1f035749abf7a · `passkey-aa` 6efdbd42271d0aed |
| test helpers | `local-bundler` 20425419bdff6f13 · `grant-cli` 1808555ad7aef1ca · `test-paymaster` 86b767e64cf88806 · `safe-passkey-code` 12f5cf056a7c5a41 · `memory-guard` cdd00af73bcd5904 · `fork-deploy` e57b8571afd64d83 |
| applied patch | `work/independent-login-browser.patch` 75d6923b1c20e01d |

The final account-first run used exactly these site sources. The passkey-ui, management, account-startup and EOA runs
predate one later edit: `deployments.js` restored the wallet guard inside the hosted-only `_doMove`. That edit is covered
by `deployment-move` (21/21), and the final account-first run used the final `deployments.js`.

Full per-file hashes, git state and attribution: `work/browser-final-source-inventory.json` (120 files: 59 untracked, 30
modified, 31 clean).

## 5. Remaining blockers (precise)

1. **Startup publishing with NO wallet.**
   - The storage adapters authorize uploads by an EIP-191 signature only (`site/js/core/upload-auth.js`; the verifier
     runs inside the adapter's guest and is not in this repository).
   - A passkey account cannot make that signature. With a wallet connected, the wallet signs as uploader and the account
     commits; that path is tested.
   - Required: ERC-1271 upload authorization in the adapter (verify `isValidSignature` at an agreed block), owned by the
     storage component.
2. **Ledger source vs deployment.**
   - `contracts/EnclaveDeployments.sol` lacks `setDelegate`; the deployed rev-16d `0xB1783B61…` has it.
   - Management of records an owner holds directly needs it.
   - Do not migrate to the source ledger blindly: it would drop the deployed feature. This is the contracts owner's call.
3. **Management vendor bundle held.** `site/vendor/management.js` still matches its recorded committed sources.
   `network/management-outcome.mjs` and `management-routes.mjs` drifted (uncommitted move core), so management-unit test 1
   fails (27/28). Rebuild only after the coordinator freezes the move core, then re-run the two management tests.
4. **Real bundlers and paymasters.**
   - Exercised against the real EntryPoint v0.7 and the pinned Safe stack, through a local test bundler (no ERC-7562
     validation rules) and a test-only sponsor paymaster.
   - Not exercised: a production bundler's validation rules, or a third-party paymaster's own policy and terms.
   - The shared signer is the component Safe designed for ERC-4337 storage rules.
5. **Legacy credit vault.** Unchanged and not offered (rev 16d credits refundable escrow only when payer = owner).

## 6. Cross-component dependencies and integration notes

These must close together; details are in the inventory's `dirtyCrossComponentDependencies`.
- **The uncommitted `sdk/sessions` change.** Every independent owner operation and top-up uses it, and
  `site/vendor/sessions.js` equals a fresh build of it.
- **`cli/independent-login.mjs` (frozen CLI worker file).** `test/helpers/grant-cli.mjs` imports its `policyMismatch`
  read-only, so the CLI login helper should commit before or with these tests. No CLI change is needed: the Safe
  signature from Sign only is ordinary ERC-1271 bytes, which `login --owner-signature` already accepts.
- **The move core.** No browser patch is needed; the browser never runs Pin/move in independent mode. If the move routes
  ever ask the owner to sign, they must:
  - accept sessions whose vault owner is a contract;
  - use the ledger delegation for records the owner holds directly;
  - check any owner signature as EIP-712 through ERC-1271 at an agreed block. A passkey account has no EIP-191 key.
- **Browser files with unestablished authorship** (`site/js/core/chain.js`, `addressbook.js`, `catalog.js`,
  `enclave-network.js`, `site/deploy.sh`): their owners must be confirmed before a browser-only commit.

No new website was built or shipped, pending the coordinator's integration review.
