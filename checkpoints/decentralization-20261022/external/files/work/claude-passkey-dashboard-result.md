# Passkey account as the independent dashboard identity: result

Browser/identity workstream, 2026-10-19. Interface: `work/passkey-dashboard-interface.txt` (written first; STATUS appended).
Paths below are relative to `work/enclave`.

No commits, production, SSH, Wine, user windows or real keys. No production transactions, funding sign-ups, or Enclave
bundler/paymaster/relay. All keys were fresh, generated locally, and used only on a local anvil fork of Base. The fork
read upstream read-only.

## Summary

The panel test now passes, and a selected passkey account works as the independent dashboard's identity. This was
exercised through real browser source in headless Chromium, with Chrome's virtual authenticator, against the pinned
Safe/passkey/4337/USDC code on a Base fork.

1. Create a passkey, add a recovery key, then compute, save and deploy the Safe. The connected wallet only pays gas.
2. Sign in: the session is owned by the Safe.
3. "Use this account as my dashboard identity" is clicked and verified at one agreed block.
4. A reload re-verifies the account before anything is listed.
5. The list shows only the Safe's and its vault's rows. The payer's own record is not listed.
6. A deployment is created through the dashboard deploy flow. The account's vault holds it, and the transaction goes
   from the payer to the vault.
7. Suspend on a vault-held row goes through the account's session.
8. Suspend on a Safe-held row: the passkey approves a Safe transaction, and the payer sends `execTransaction` to the
   Safe.
9. A stale description (threshold 2; the chain says 1) is refused on load. Nothing is listed, and a ledger send is
   refused without falling back to the wallet.
10. "Use my connected wallet" switches back: the account's rows vanish and the wallet's own record is listed.

Not done or not verified (details at the end):
- the existing wallet-mode Chromium suite (`site-independent-browser`) did not run within the 1024 MiB allocation: the
  guard stopped it at 1038 MiB, and it was not retried;
- signed owner operations, top-ups and Manage under the account identity are wired but not tested;
- the shared-signer first deployment is out of scope, as instructed.

## 1. Completing `test/site-independent-passkey-ui.test.mjs`

All runs used the guard: `node test/helpers/memory-guard.mjs --max-rss-mib 1024 --floor-available-mib 16384 -- node
--max-old-space-size=160 test/site-independent-passkey-ui.test.mjs`. One job ran at a time; only its own group was
stopped. "Min host available" is the lowest host MemAvailable during the run.

| run | peak tree RSS | min host available | outcome | exact cause and fix |
|---|---|---|---|---|
| 1 | 731 MiB | 16398 MiB | fail | The test profile had `maxBlockAgeSeconds: 1e8`, above the validator's 86400, so the profile was invalid and the panel never mounted. Set to 86400; added an `INDEPENDENT.state === "on"` assertion. |
| 2 | 864 MiB | 16391 MiB | fail | `.acct-panel summary` matched the nested import `<details>` too. Selector changed to `.acct-panel > summary`. |
| 3 | 840 MiB | 17065 MiB | fail | Timeout waiting for "session … is live". No diagnostics yet. |
| 4 | 995 MiB | 16936 MiB | fail | Timeouts now print the status, page errors and console. The UI was correct: it said "session 0xc5e6a4…4cc770 is live in vault 0x8f48b4…aF809F". The test regex expected a prefix-only, lowercase `short()`. Regex fixed. |
| 5 | 850 MiB | 17946 MiB | fail | Driver bug: `getLogs({fromBlock: 0})` made anvil fetch Base history from the public upstream, which answered HTTP 429. Logs now start at fork block + 1. |
| 6 | **929 MiB** | 18111 MiB | **2/2 pass** | Panel test and identity test. |

Each rerun fixed a specific, diagnosed cause; none was a blind retry. Memory was trimmed between runs 4 and 5: Chromium's
network and audio services run in the browser process (`NetworkServiceInProcess`, `AudioServiceOutOfProcess` off). That
removed two helper processes; at a comparable point the peak fell from 995 to 850 MiB.
- Run 6 peak breakdown: driver node 275, chrome 206 + 106 + 103 + 37 + 34, anvil 169 (MiB).
- No UI defect was found in the panel itself. All panel failures were in the test or the driver.

## 2. What was built

### Identity (`site/js/core/identity.js`, new)

`selectAccountIdentity` (identity.js:129) runs only on the explicit button. `verifyAccountIdentity` (:75) checks, at
**one** quorum-agreed block (a reader pinned to a single snapshot), that:
- every passkey signer is re-derived by the pinned factory (`verifyAccountProfile`);
- the account is a deployed Safe on the pinned singleton (`identifyAccount`), whose on-chain owners and threshold equal
  the description and whose passkey owners are recognized passkey signers;
- the only module is the pinned 4337 module;
- no guard is set;
- the fallback handler is pinned.

A predicted-only Safe is refused.

What is stored: `enclave_identity:v1:<chainId>` = `{kind, safe, block}`.

On each load the stored selection is re-verified by `ensureIdentity` (:108):
- it is "pending" until then;
- on failure it is "refused" with the reason. Agreement failures are marked retryable; definite mismatches are not
  re-read in a loop.

`actingOwner` (:66) returns the Safe only when verified, and otherwise null. It never falls back to the wallet.

Changes announce `enclave:identity`.

### Sessions (`site/js/core/sessions.js`)

- **Per-identity session pointer** (`activeKey`, :23).
  - The wallet keeps `enclave_wallet_session`.
  - An account uses `enclave_account_session:<chainId>:<safe>`.
  - `currentSession` (:61) returns an account's session only when the identity is verified and the record's owner is
    that Safe.
  - The account panel's sign-in sets the account pointer (`setAccountSession`, :78).
- **Wallet sign-in refused under an account identity** (`startDirectSession`, :676), with the reason.
- **Ledger calls** (`independentLedgerSend`, :761). Under an account identity:
  - a vault-held row goes through the session;
  - a Safe-held row goes to `safeLedgerSend` (:881): passkey approvals over `safeTxHash`, then an agreed simulation of
    `execTransaction`, then the payer submits;
  - anything else is refused. **A ledger call is never sent as the wallet**: the old `walletSend` fallback is not
    used under an account.
- **Owner operations and top-ups** (`accountOwnerOp` :835, `accountTopUp` :857):
  - the Safe signs through its passkeys (ERC-1271, `mode: "signed"`);
  - the result goes through `verifyOwnerSubmission`'s agreed simulation;
  - the payer submits.
  - The connected wallet is used as an approver only when it is one of the account's key owners and the passkeys
    alone are short of the threshold.

### Safe calls (`site/js/core/passkey-account.js`)

- `prepareSafeCall` (:294) and `execSafeCall` (:304): a CALL only, with no delegatecall, refund or gas price.
- `safeApprover` (:255) can target a specific key owner.
- `prepareOwnerChange` is now built on `prepareSafeCall`.

### Listing (`site/js/core/api.js`)

Under an account identity, the list is `[safe, vaultFor(safe)]`, read only after verification.
- A pending or refused account throws `IdentityError`.
- A failed vault read fails the list; it no longer silently drops the vault rows on this path.

### Deployments panel (`site/components/deployments/deployments.js`)

- Rows are keyed `safe:<address>` under an account.
- Listing works without a wallet. Polling continues.
- `enclave:identity` (:482) clears rows, the last-good cache, open panels and the cached session.
- An identity refusal never shows stale rows (:654). It reads "No apps are shown: <reason>".
- The Startup owner check and the Transfer self-check use the acting owner.

### Create (`site/js/pages/deploy.js`, `accountCreate` :359)

Under an account identity, the record is created by the account's session (`deploy.create`), and the vault holding it
is checked on the ledger afterwards. The following are refused with the reason, and nothing is sent:
- prepare-only (owner-committed startup);
- ETH funding;
- paid apps (the vault requires a paid app to be named in the grant);
- no account session.

Host quotes use the acting owner for "free for this owner".

### UI

- `account-ui.js`: "Use this account as my dashboard identity" and "Use my connected wallet", with the state shown
  (verified at block N, checking, or refused: reason).
- `mountIdentityBar` (:293), mounted by `dashboard.js` above the list:
  - "Acting as passkey account 0x… · gas paid by 0x… (the payer owns nothing here)";
  - pending and refused texts;
  - "Acting as your wallet … · it owns and pays".
- `dashboard.js` does not bounce a wallet-less visitor who has a selected account.

### Unchanged

- **Hosted mode:** `currentIdentity()` is always the wallet there.
- **EOA (wallet) identity:** the same pointer key, listing, `ledgerSend` fallback and owner operations.

### Docs

`docs/network/independent-dashboard.md` (passkey account section and Tests).

## 3. Tests run

| test | result | notes |
|---|---|---|
| `site-independent-passkey-ui` (Chromium + virtual authenticator + Base fork) | **2/2** | Peak 929 MiB; the real panel and the dashboard-identity flow described above. |
| `site-independent-identity` (new, Node) | **7/7** | Rules with stand-in chain verifiers. **8/8 mutations killed** in an isolated `/tmp` copy, since deleted: unknown module, guard, undeployed, pending-falls-back-to-wallet, owner/threshold mismatch, not-one-block, transient-never-retried, other account's description. |
| `site-independent-passkey-aa` (Node + Base fork) | **6/6** | Peak 391 MiB; re-run because the owner-change helpers were refactored. |
| `site-independent-passkey-account`, `-owner-signature`, `-account-providers` | 8/8, 5/5, 6/6 | |
| Node regressions for the touched modules | all pass | `api-base-binding` 11, `config-override-plan` 8, `dashboard-host-auth` 11, `dashboard-tls-status` 11, `deploy-zero-fund` 2, `deployment-move` 21, `models-read-only` 5, `pay-domain-pinning` 5, `pricing` 64, `runlog-retry` 12, `site-independent-profile` 6, `site-ledger-calls` 7, `site-list-failure` 12, `site-session-auth` 18. |
| `site-independent-management-unit` | 27/28 | Exact cause below; not mine, not rebuilt. |
| `site-independent-browser` (wallet-mode Chromium suite) | **not verified** | The guard stopped it at **1038 MiB > 1024** (min host available 18847 MiB) before any test reported. Peak: driver node 335 (the rig runs adapters, directory and host in-process) + 51, anvil 170, chrome about 481. No retry, per the instruction. I had tried lean Chromium flags for this run and reverted them, since they were never verified. |

## 4. What is not done or not verified

- **Wallet-mode regression in Chromium.** The EOA identity code paths are unchanged in logic: the same pointer key, the
  same fallback. The passkey-ui test's last step lists the wallet's own record after switching back. The Node
  regressions pass. But the 18-test wallet-mode Chromium suite does not fit 1024 MiB as written, so it was not
  re-verified this round. It needs a larger allocation, or a split rig.
- **Untested under the account identity.** Signed owner operations (extend, environment, promote, end all), top-ups and
  host management (Manage) are routed to the account paths in code. No test exercises them yet.
- **Deploy dialog.** The create step was driven by calling the real `deployOnChain` flow from the dashboard page, not by
  clicking the Apps page's quick-deploy dialog.
- **Account-created records are STAGING.** The account's sessions may change their version. Production moves need a
  signed owner operation, which is untested.
- **Out of scope, as instructed.** A passkey-only first deployment with no gas payer needs the shared signer, so the
  signer-first/shared-signer expansion is left for another task. No bundler or paymaster suggestion lists were added,
  and no Enclave default exists.
- **Legacy credit vault.** Unchanged and not offered. The deployed rev-16d ledger credits refundable escrow only when
  payer == owner, and the credit-vault implementation bytecode is still not re-verified. See the earlier reports.

## 5. Management bundle (`site/vendor/management.js`)

Not rebuilt. `test/site-independent-management-unit.test.mjs` test 1 ("the vendored bundle is exactly a fresh build")
fails because these shared management sources have uncommitted modifications I do not own:
- `network/management-auth.mjs`
- `network/management-client.mjs`
- `network/management-gateway.mjs`
- `network/management-outcome.mjs`
- `network/management-routes.mjs`

They are the release/move sources under independent security review 30692, with the provenance hold still in place. The
other 27 tests pass.

`git status` also shows `site/vendor/sessions.js` as modified. I did not touch it this round.

## 6. Other workers

- 27 `anvil --chain-id 31337` processes, started Oct 13, Oct 14 and today at 17:32, belong to other workers or their
  orphans. They were left untouched.
- None of my processes remain (no fork, `chain-id 8453` anvil or headless Chromium).
- I did not edit any CLI, Windows, Go, custody, SDK or shared management (`network/management-*`) file.

## Files changed this round

- **New:**
  - `site/js/core/identity.js`
  - `test/site-independent-identity.test.mjs`
  - `work/passkey-dashboard-interface.txt`
  - this report
- **Modified:**
  - `site/js/core/sessions.js`
  - `site/js/core/api.js`
  - `site/js/core/passkey-account.js`
  - `site/js/core/account-ui.js`
  - `site/js/pages/deploy.js`
  - `site/js/pages/dashboard.js`
  - `site/components/deployments/deployments.js`
  - `test/site-independent-passkey-ui.test.mjs`
  - `docs/network/independent-dashboard.md`
- `test/site-independent-browser.test.mjs` was edited and then reverted. It is unchanged.
