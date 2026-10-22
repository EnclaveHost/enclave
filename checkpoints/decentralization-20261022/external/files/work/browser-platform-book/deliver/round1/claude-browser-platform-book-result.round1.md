# Browser address-book following ("book mode"): integration review and completion

Date: 2026-10-20. Candidate: `work/browser-platform-book/` (snapshot of `work/enclave` at HEAD fd1cc627, 2026-10-20T02:34-07:00).
Governing requirements: `work/effective-goal-requirements.txt`.
- Administrators keep contract administration and migration, delisting, bans and abuse enforcement.
- Existing contracts are reused; no anti-admin work.

**Status: source-verified in the candidate only. Nothing is activated.**
- The patch is NOT applied to `work/enclave`.
- No commits, staging, deployments, chain writes, signatures with real keys, publishing or profile activation were made.
- Root owns activation.

## Deliverable

- **Patch:** `work/browser-platform-book/deliver/browser-platform-book.patch`
  - sha256 `b1b97a0c345c3c08ac41a47ecb7611e3d1a8e4ee5ba7c79cc964e650b3a3bf5f`, 757 lines.
  - 13 modified files and 1 new file.
- **Inventory:** `work/browser-platform-book/deliver/INVENTORY.json`. Per file it records `base_sha256`, `main_sha256_now` and `new_sha256`.
- **Drift check at delivery:** every modified file in `work/enclave` still equals the snapshot base, so there are no newer root changes to merge.
  - The patch was applied (`patch -p1`) to a scratch copy of the current main files.
  - The result is byte-identical to the candidate tree.
- **Apply:** `cd work/enclave && patch -p1 < ../browser-platform-book/deliver/browser-platform-book.patch`. Check `base_sha256` first.
- **Preserved, untouched:**
  - root's streaming ownerRead fix (`custody/v2/owner-secrets.mjs`);
  - root's site-release lock correction;
  - the frozen account-upload result.

| File | Change |
| --- | --- |
| `site/js/core/platform-addresses.js` | `retiredLedgers()`, `isLedgerRecoveryCall()`, and the recovery exception in `assertPlatformTransactionCurrent` |
| `site/js/core/independent-chain.js` | `retiredLedgerRecords(owners)` and `retiredLedgerRows()`: quorum reads of the replaced ledger at the agreed block |
| `site/js/core/api.js` | `listDeployments` adds replaced-ledger records; records carried over by import are merged into one row |
| `site/components/deployments/deployments.js` | Read-only replaced-ledger note, "Recover funds" (wallet or passkey Safe), honest note when only the vault can refund |
| `site/js/core/sessions.js` | Binding check before passkey approvals in `safeExecute`; check before the passkey USDC authorization signature |
| `site/js/core/fund.js`, `site/js/core/pay.js` | Binding check before the wallet signs an EIP-3009 authorization or permit |
| `scripts/network/browser-profile.mjs` | `--address-book` selects the ORIGINAL session factory; `verifyBookBinding` runs under `--verify-chain` |
| `test/helpers/fork-deploy.mjs`, `test/site-independent-passkey-ui.test.mjs` | Fixture fixes (below) |
| `test/helpers/independent-browser-rig.mjs` | `deployLedger()` for a replacement ledger (local anvil only) |
| `test/site-existing-contract-sessions.test.mjs` | 2 new book-mode subtests: ledger migration, existing grant, recovery |
| `test/browser-profile.test.mjs` | Factory selection and `verifyBookBinding` tests |
| `test/site-platform-ledger-recovery.test.mjs` (new) | Unit tests of the recovery allowlist, in the following tab and in a fresh tab |

## 1. Passkey fixture timeout (`ENCLAVE_TEST_PLATFORM_BOOK=1`): diagnosed and fixed

- **Exact phase.** Root's stuck hash `0x68546d85…ec82` is the **book `setMany` transaction**.
  - I reproduced it deterministically with `diag/fork-deploy-diag.mjs`: the same anvil flags, root's payer `0xe3FC…7703` impersonated, and the same fixture steps (`logs/diag-2.log`).
  - Every phase hash was logged, and the 9th transaction matched root's hash exactly.
  - All 10 phases mine in about 7 s. The transaction does not stick in anvil.
- **Root cause.** A race in viem 2.53.1 `waitForTransactionReceipt`, under anvil automine.
  - When the first receipt read misses, the watcher re-reads the pending transaction with `retrying = true`.
  - A block-number event that arrives during that window is dropped (`if (retrying) return`).
  - `prevBlockNumber` has already advanced, so that block is never emitted again.
  - Automine makes no further block, so the wait runs out its 180 s default. Root's run lasted 194 s: about 14 s of deploys plus 180 s.
- **Fix (no check weakened).**
  - `fork-deploy.mjs` polls `eth_getTransactionReceipt` directly every 250 ms, for up to 120 s, and still requires `status === "success"`.
  - On timeout it reports the head, txpool status and the transaction's block.
  - The test's own two receipt waits use the same direct poll.
- **Two further harness defects showed up once book mode got past setup.**
  - **Stale `since` window.** `pc.getBlockNumber()` is cached for 4 s, so step 7's "created since b" window also caught step 6's paid record.
    - Diagnosed with a throwaway diagnostic copy (deleted).
    - Fix: the public client is created with `cacheTime: 0`.
  - **Log query ahead of head.** `waitSuspended` then queried logs from head+1, which anvil rejects. It now waits until the chain reaches `fromBlock`, as `logsSince` already did.
- **Result:** book mode **3/3 pass** (`logs/passkey-book-6.log`); fixed-factory mode **3/3 pass** on the same final code (`logs/passkey-fixed-2.log`).
- **Same latent race elsewhere (reported, not changed):** `pc.waitForTransactionReceipt` on anvil in `cli-independent-rig`, `independent-browser-rig`, `custody-rig`, `independent-custody-rig`, `owner-read-rig`, `sessions-chain`, `local-bundler`, `test-paymaster` and `grant-cli`.

## 2. Old-ledger funds and grants after an admin migration

**Overblocking: confirmed and fixed minimally.** The generic retired-target rejection blocked every call to a replaced ledger. That included the owner's own `refund(id)`, the only way back to escrowed USDC held there.

| Call to a replaced ledger | Result |
| --- | --- |
| `refund(bytes32)`, exact 36-byte calldata | Allowed |
| `setActive(bytes32,false)`, exact calldata | Allowed |
| `create`, `fund`, `setActive(true)` | Refused |
| `refund` with trailing bytes | Refused |
| ERC-20 `approve(oldLedger, …)` | Refused |
| Any call to a replaced non-ledger contract (catalog, router, …) | Refused |

- If the administrator re-selects a contract, it becomes active again and leaves the replaced set.
- No contract was invented or changed.

**Discovery.**
- Book profiles list the wallet's and its vault's (or the passkey Safe's and its vault's) records on every ledger replaced in this tab.
- A fresh tab also finds the profile's own pinned ledger once the book has moved. No cache or server is involved.
- All reads use the agreed snapshot. Code and selector presence (`count`, `getPage`, `refund`) are checked, along with `retired()` and `refundableOf`.

**Migration by import (the platform's real procedure, `ledger-15d-base.json`: 70/70 imported).**
- Imported records keep their ids, so the same id exists on both ledgers.
- The dashboard shows one row (the current ledger's) and attaches what the replaced ledger still holds for it. No duplicate rows or `data-id`s.

**Who can recover.**
- **Wallet-owned records:** the wallet refunds at any time.
- **Passkey-Safe-owned records:** the Safe refunds through `safeExecute`, with passkey approval; the binding check runs first.
- **Vault-owned records before `retire()`:** NOT recoverable from the client. The vault routes ledger calls through the book's current ledger.
  - The UI says so and shows no button that would revert.
- **After the administrator calls `retire()`:** anyone may push `refund`, which always pays the record's owner (the vault). The UI offers it.
  - Withdrawing that from the vault is the existing owner-op path. It is not exercised by my test.

**Existing grants.**
- With the replacement imported, the existing session (same `sid`, no new grant) creates on the new ledger with the first RPC down.
- The profile is not rewritten.

**Contract-level finding (no client fix possible, reported).**
- If an administrator replaces the ledger *without* importing, an existing SessionVault's first creates on the new ledger revert with `Exists()` (`0x846ec056`, `SessionVault.sol:1086`).
- Ledger ids are `keccak(sender, nonce)`, and the nonce restarts at 0, so they collide with ids the vault already holds.
- A ledger migration must keep importing records (as 15d did).

**Browser evidence.** `test/site-existing-contract-sessions.test.mjs`, **15/15 pass** (`logs/book-browser-3.log`): root's 13 plus 2 new book-mode subtests. They cover:
- import, book switch and existing-grant create on the new ledger;
- merged rows;
- every refused call stops before the wallet (no wallet mutation counted);
- a fresh tab finds the replaced ledger from the profile's pin;
- the wallet-owner refund through the real button, exact USDC amount and one wallet transaction;
- the vault record shows the not-retired note and no button;
- admin `retire()`, then a permissionless refund through the button pays the vault and the sender's USDC is unchanged;
- refusals still hold after retirement.

## 3. Fresh confirmation before wallet or passkey signing

- **Fixed: `sessions.safeExecute` (passkey account, wallet pays gas).**
  - The passkeys approved the inner call before any binding check.
  - The later `sendTx` check saw only the Safe as its target, so a retired inner target was never refused.
  - It now runs `assertPlatformTransactionCurrent(to, data)` before any approval. The account-pays path already checked in `sendAsAccount`.
- **Fixed: typed-data signatures that name a platform contract.**
  - the passkey USDC `ReceiveWithAuthorization` to the ledger (`sessions.js`);
  - the wallet EIP-3009 authorization (`fund.js`);
  - the wallet permit to the router (`pay.js`).
  - Each now confirms the binding before the prompt. Outside book mode the check returns immediately.
- **Reviewed, no change.**
  - Session grants (`grant.js`, `startSession`): the grant binds the factory and vault. Vaults resolve the book at execution, and `sessionAuthority()` runs before preparation.
  - Transactions: `wallet.sendTx`, `sendAsAccount` and `submitPrepared` already check.

## 4. Other review items

| Item | Finding |
| --- | --- |
| In-flight or snapshot binding changes | A newer or conflicting snapshot is refused. Any change applied by the resolve refuses the operation ("review and prepare again"). Covered by root's tests and mine. |
| Wrong or codeless book entries | Required `registry`, `deployments` and `appCatalog` must be nonzero with code at the agreed block, else the whole map fails (root's reader tests). `sessionAuthority` also refuses a factory bound to another book. |
| Poisoning and cache | No retained authority cache in book mode. A minority RPC cannot select entries. A fresh tab re-derives everything from the book and the profile pin (unit and browser tests). |
| Optional service retirement | A zero entry turns the service off (`""`), with no fallback to the profile (root's browser subtest 4). |
| Native pins | `native-instructions.js` uses the resolved book's deployments and registry at the stated block. Its factory comes from the profile, which is now the original factory for generated book profiles. Native owner verification accepts it (`network/owner-signature.mjs`). No hard-coded factory or ledger pins in `site/`, `network/` or `scripts/` (only descriptive text in `site/develop.html`). |

## 5. Production profile generation: the original factory, not the alternate authority

- **Before.** `browser-profile.mjs --address-book` only added the field. It kept `sessionVaultFactory` = the alternate `PinnedSessionVaultFactory` 0xec92… from the authority pins.
  - That factory never consults the book, and `sessionAuthority()` requires the implementation's `book()` to equal `profile.addressBook`.
  - So a book profile generated that way could not open sessions.
- **Now, with `--address-book`:**
  - `contractPins.sessionVaultFactory` = `legacySessionVaultFactory` 0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c, taken from the same digest-checked authority profile;
  - all other pins are unchanged;
  - if the profile has no original-factory record, generation refuses;
  - fixed profiles keep the alternate pinned factory.
- **With `--verify-chain`, at the verified block, on every RPC (they must agree exactly):**
  - factory → `implementation()`;
  - `implementation.factory()` = this factory;
  - `book()` = `--address-book`;
  - `usdc()` = the profile's USDC;
  - the book has a nonzero `owner()`;
  - `book.addr(registry/deployments/appCatalog)` equals the profile's starting pins. Otherwise: "review the pins before publishing".
- **Tests:** `test/browser-profile.test.mjs`, 9/9 pass.

## 6. Test evidence (shared queue; caps 256 units / 1408 Chromium; 16 GiB floor; no swap)

| Run | Log (`work/browser-platform-book/logs/`) | Result |
| --- | --- | --- |
| Fixture diagnosis, root's payer | `diag-2.log` | `setMany` = `0x68546d85…`; all phases mined |
| Passkey UI, book mode, final code | `passkey-book-6.log` | 3/3 pass |
| Passkey UI, fixed mode, final code | `passkey-fixed-2.log` | 3/3 pass |
| Book browser (fixed and book), final code | `book-browser-3.log` | 15/15 pass |
| Serial units: root's 7 files + mine + 15 files importing changed modules | `units-2.log` (files in `units-files.txt`) | 289 tests: 283 pass, 0 fail, 6 skipped |

- The 6 skips are opt-in live reads (`ENCLAVE_LIVE_READS=1`).
- **Not passes:**
  - `passkey-book-2/3/4/5` were stopped by the host-memory floor (host MemAvailable ≈16.1–16.4 GiB from other workloads; my tree ≤1.28 GiB).
  - `passkey-book-1` (attempt 3) failed on the stale `since` window, since fixed.
  - `book-browser-1/2` were expectation fixes during development.
- **Not run:** other Chromium suites that touch `deployments.js` / `sessions.js` (in fixed mode the new checks are no-ops), and root's serial units in `work/enclave` itself.

## 7. Remaining integration (root-owned; nothing here is done or claimed)

1. **Apply the patch** to `work/enclave` after checking `base_sha256`. Then rerun the serial units and the three browser suites above in main.
2. **Generate the book-mode default profile** from the reviewed authority profile, with announced operator inputs:

   ```
   node scripts/network/browser-profile.mjs --authority contracts/deployments/network-profile-base.json \
     --expect-digest sha256:<out-of-band digest> --expect-pins contracts/deployments/contract-pins-base.json \
     --address-book 0xab214342d5a490150a4a977063a2f88e21f80907 \
     --rpc <https A> --rpc <https B> [--rpc <https C>] [--storage-plan …] [--directory https://…] \
     --verify-chain --out browser-profile.json
   ```

   - The output must show `sessionVaultFactory` 0x1f5c…, not 0xec92….
   - `--verify-chain` must print the binding line.
   - Publish the fingerprint through a trusted channel.
3. **Site release.** Either:
   - ship it built in, by setting `BUILT_IN_PROFILE_TEXT` in `site/js/core/independent.js` (currently `null`) to the exact generated text; or
   - keep profiles user-imported, with an announced fingerprint.

   Then rebuild and verify the release under root's site-release procedure (`work/site-release-interface.txt`: content-addressed tree/CAR, header block, `.site-release.lock`). Activation (pin and live link) stays root's.
4. **Operational rule for future ledger migrations:**
   - keep importing records into the replacement (avoids vault `Exists()`);
   - `retire()` the old ledger once the import is done, so vault-held escrow there becomes permissionlessly refundable to the vaults;
   - the dashboard then offers the recovery.

## Gap checklist (actual gaps; sources)

- **Vault-held escrow on a replaced, not-yet-retired ledger** cannot be refunded from the browser. Contract routing goes through the book (`SessionVault.sol` `L.refund` via the current book ledger). Mitigation: administrator `retire()`.
- **Ledger replacement without import** breaks existing vaults' first creates (`SessionVault.sol:1086` `Exists()`). This is a migration-procedure requirement, not a client fix.
- **Replaced-ledger discovery** covers ledgers replaced while a tab watched, plus the profile's own pin. A ledger replaced *between* two other replacements while no tab was open is not rediscovered.
  - There is no on-chain history of book entries without event scans. The book's events could provide it; not implemented.
- **Native client** pins stay fixed at the block where the instructions were generated (root's note says refresh after updates). A native follow-the-book mode is not part of this task.
- **Receipt race in other anvil rigs** (list in §1): reported, not changed.
- The **previous `browser-default-independence` task** is superseded in direction by the effective requirements.
  - Its candidate and evidence are preserved under `work/browser-default-independence/`.
  - Its result file was never written. It had no passing Chromium run.
