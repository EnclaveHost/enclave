# Browser address-book following ("book mode"): integration review and completion (round 2)

Date: 2026-10-20. Candidate: `work/browser-platform-book/tree` (snapshot of `work/enclave` at HEAD fd1cc627, 2026-10-20T02:34-07:00).
Governing requirements: `work/effective-goal-requirements.txt`.
- Administrators keep contract administration and version migration, delisting, bans and abuse enforcement.
- Existing deployed contracts are reused; no contract was changed or added.

**Status: source-verified in the candidate only. Nothing is applied to main or activated.**
- No commits, staging, deployments, live chain writes, real signatures, credentials, publishing or profile activation.
- No agents and no Wine.
- Root owns review, integration and activation. The heartbeat worker's CLI/network files are untouched: no overlap with this patch.

Round 2 fixes root's four review findings (§A). Round-1 evidence and deliverables are preserved unchanged under `work/browser-platform-book/deliver/round1/`:

| Round-1 file | sha256 |
| --- | --- |
| Patch | `b1b97a0c345c3c08ac41a47ecb7611e3d1a8e4ee5ba7c79cc964e650b3a3bf5f` |
| Inventory | `01b2c1d53c7333a6abaab4e38d780f61973759c3eafb95d36965a0c5076a2c1e` |
| Report | `ea61bce8b6749f45a67855dc56ffbf26d189167b7006d252176d17a9a85bc2d6` |

Round-1 logs remain in `work/browser-platform-book/logs/`.

## Deliverable (round 2)

- **Patch:** `work/browser-platform-book/deliver/browser-platform-book.patch`
  - sha256 `32058edb483c4fb6210777338c7529481cee2aeb35f14ee4d1981ccd4131f77d`, 1409 lines.
  - 14 modified files and 3 new files.
- **Inventory:** `work/browser-platform-book/deliver/INVENTORY.json`, sha256 `d10a14820b9c8d141a5f58fc0b3ed37f047235b9c6c13cbf95a063f678b96f4b`. Per file it records `base_sha256`, `main_sha256_now` and `new_sha256`.
- **Drift check at delivery:** every modified file in `work/enclave` still equals the snapshot base (`main_matches_base_for_all_modified: true`), and no new file exists in main.
  - The patch was applied with `patch -p1` to a scratch copy of the current main files.
  - The result is byte-identical to the candidate.
- **Apply:** `cd work/enclave && patch -p1 < ../browser-platform-book/deliver/browser-platform-book.patch`.
- **Preserved, untouched:** root's streaming ownerRead fix (`custody/v2/owner-secrets.mjs`), root's site-release lock correction, and the frozen account-upload result.

| File (`new_sha256`, first 16 hex) | Change |
| --- | --- |
| `site/js/core/platform-addresses.js` (`878cac62e49f84d3`) | Recovery allowlist (round 1). Ledger history: the profile's verified list, plus `scanLedgerHistory()` over the book's own `AddressSet(deployments)` events after it. `retiredLedgers()` never includes an active ledger. |
| `site/js/core/independent-chain.js` (`f4c4717d596d89ef`) | `retiredLedgerRecords` runs the history scan and returns its status. `withReplacedHoldings()` keeps one holding per replaced ledger, with that ledger's owner. |
| `site/js/core/ledger-recovery.js` (new, `b43e1b2d5b8a9990`) | Pure `recoveryRoute(holding, {identity, acting})`. |
| `site/js/core/api.js` (`3f9e4447fec47fb9`) | `listDeployments` uses `withReplacedHoldings`; the scan reports `replaced` and `ledgerHistory`. |
| `site/components/deployments/deployments.js` (`59dcf050fd5e17f9`) | One note and one button per holding (`data-rid` + `data-ledger`), routed by the old owner. The account path uses `needPayer()`, not `connectWallet()`. |
| `site/js/core/independent.js` (`f328853af1c888c7`) | Optional profile field `ledgerHistory {through, ledgers}`. |
| `scripts/network/browser-profile.mjs` (`b7e7a8e062fe3df9`) | Original session factory and `verifyBookBinding` (round 1). New `--ledger-history-from` / `bookLedgerHistory()`. |
| `site/js/core/sessions.js`, `fund.js`, `pay.js` | Binding checks before passkey or wallet signatures (round 1; unchanged in round 2). |
| `test/helpers/fork-deploy.mjs` (`902799837cf48ec1`) | Receipt-race fix (round 1). New `--replace-ledger <old> <registry> <feed>`: new ledger, `importDeployments` + `importEarn`. |
| `test/helpers/independent-browser-rig.mjs` (`f8f9c67dc788f88a`) | `deployLedger()`, plus new `migrateLedger(old)` (import records and runner rates). |
| `test/site-existing-contract-sessions.test.mjs` (`3510422c9f8f3bae`) | Book-mode subtests 5 and 8 (8 rewritten for round 2). |
| `test/site-platform-book-safe-recovery.test.mjs` (new, `79bb924b452a0438`) | Passkey Safe recovery with no wallet anywhere. |
| `test/site-platform-ledger-recovery.test.mjs` (new, `2946c3720dad0892`) | Unit regressions. |
| `test/browser-profile.test.mjs` (`1bc7b6c09d2633bf`) | Generator tests, including ledger history. |
| `test/site-independent-passkey-ui.test.mjs` (`b02efc0d02617aed`) | Round-1 harness fixes (unchanged). |

## A. Round-2 review findings

### 1. The OLD record owner decides recovery (was: the current owner)

- **Defect confirmed.**
  - Round 1 merged a replaced-ledger record into the current row as `replacedLedger {ledger, retired, refundable}` and dropped that ledger's owner.
  - The button was then chosen from the **current** `d.owner`.
  - After an import, ownership can change: e.g. wallet → its vault via `transferDeployment` on the new ledger.
  - So the UI could offer a refund the old ledger refuses (`!owner`), or hide one the old owner can make.
- **Fix.**
  - Each holding keeps `owner` as read on **that** ledger, at the agreed block.
  - `recoveryRoute` routes by that owner:
    - **`"account"`** (the account's own path): the identity is a passkey account and the old owner is its Safe.
    - **`"wallet"`:** the identity is a wallet and the old owner is that wallet. An account dashboard never routes through an unrelated gas-paying EOA.
    - **Retired ledger:** either path, since anyone may push and the refund pays the owner there.
    - **Otherwise:** no button, and the note "only that owner can refund it".
  - The note shows "Owner there: …".
- **Unit regressions** (`site-platform-ledger-recovery.test.mjs`):
  - the full route matrix: wallet, Safe, the wallet's vault, the Safe's vault and an unrelated EOA, each retired and not;
  - the merge, with current owner W and old owner V (and the reverse), across two ledgers.

### 2. One holding per ledger; no ledger's balance hides another's

- **Defect confirmed.** A single `replacedLedger` slot per row meant a second replaced ledger with money for the same imported id overwrote the first.
- **Fix.**
  - `row.replacedHoldings[]` keeps every (ledger, owner, retired, refundable) for the id.
  - Each holding has its own note and button, keyed by `data-ledger`; the refund is sent to exactly that ledger.
  - A carried-over row hides only zero holdings; a read-only left-behind row shows all of them.
  - After a successful refund the list refreshes from the chain, and the other ledgers' holdings are still read and shown.
- **Browser regression** (subtest 8, below): the same record holds money on L0 (owner: wallet) and L1 (owner: its vault). After the L0 refund and refresh, the L1 note and its exact amount are still shown.

### 3. Cold-tab migration history: verified, not dependent on tab uptime

There are two layers. Both use only the existing original book (`AddressSet(bytes32 indexed key, address value)`, `contracts/EnclaveAddressBook.sol`) and existing ledgers. The transaction allowlist is not widened: a history ledger, like any replaced ledger, only accepts exact `refund(id)` or `setActive(id,false)`, and every other call to it is now refused.

1. **Profile-recorded history** (`ledgerHistory {through, ledgers}`, ≤32 addresses, optional, address-book profiles only).
   - `browser-profile.mjs --address-book … --verify-chain --ledger-history-from <book deploy block>` reads the book's `AddressSet("deployments")` events up to the verified block, in `--log-span` ranges (default 2000).
   - **Every** RPC must return the identical log set, each log must match the request exactly, and each historical ledger needs code at that block. Nonzero values other than the current pin are recorded.
   - The list sits inside the profile text, so the published fingerprint (or a built-in profile) covers it, like every other binding.
   - Any tab, however fresh, knows these ledgers before reading anything.
2. **Browser scan after `through`** (`scanLedgerHistory`).
   - The book's own `AddressSet("deployments")` events from `through+1` to the agreed head, in 2000-block ranges, through the existing quorum reader's `logs()`. `quorum` RPCs must return the identical, complete set.
   - Topics and data shape are checked. A malformed record or a disagreement adds nothing and fails the scan visibly.
   - Records of a discovered ledger are read only after ledger code and selectors check out (`retiredLedgerRecords`).
   - **Bound:** at most 40 ranges (80,000 blocks, about 1.85 days of Base) per listing call. Progress is kept in tab memory only; the next listing continues.
   - Until it is done, the scan note says "checked through block X of Y; the next refresh continues" instead of claiming completeness.

**Limits, stated plainly:**
- RPC agreement is not a light client: a quorum of colluding RPCs could hide or invent an `AddressSet` event in the post-`through` window. The same is true of every other read in this mode.
  - An invented "ledger" could only be shown and offered recovery calls (no value, no approval).
  - A hidden one leaves its funds unseen until a regenerated profile lists it.
- A cold tab whose profile is old works through the gap 80,000 blocks per refresh. A profile regenerated at each site release keeps the gap small; ledger migrations are rare admin events.
- Profiles without `ledgerHistory` (and fixed profiles) keep round 1's discovery: the profile pin plus changes seen in this tab. The scan note says the profile records no history.
- **Not run:** the generator against the live Base book. It has only been run against scripted RPCs in unit tests. The book's live history (the 15d record names `migratedFrom` 0xb36DCE…) is therefore not claimed.

**Regressions:**
- **Unit:**
  - schema;
  - cold-tab seeding (a ledger replaced before the profile was generated is recovery-only in a brand-new tab);
  - scan by quorum (only the book's `deployments` topic after `through`; zero and the current ledger skipped);
  - a disagreeing RPC inventing a ledger, which is refused and never listed;
  - a malformed record, refused;
  - a gap longer than one call's bound, labeled incomplete and then completed;
  - generator chunking, agreement, out-of-request logs and a codeless ledger.
- **Browser** (subtest 8): the profile's `through` is the block before any replacement. After L0 → L1 → L2, a cold tab finds L1 only through the book's history, and lists and recovers it.

### 4. No unrelated wallet for a Safe-owned refund

- **Defect confirmed.** The handler called `connectWallet()` whenever no provider was present, before choosing the account path.
- **Fix.** The account path calls `needPayer()`, the dashboard's existing rule: a wallet only when it, not the account, pays the account's gas. The wallet path is unchanged.
- **Browser regression** (new `site-platform-book-safe-recovery.test.mjs`):
  - Setup: no injected wallet and no wallet session. A passkey Safe pays its own gas through the local bundler (real EntryPoint v0.7) on a Base fork. The original-style book and factory come from `fork-deploy --legacy-session-factory`.
  - The Safe-owned record is funded on L0, then the admin migrates by import and repoints the book.
  - The cold dashboard shows `data-by="account"` and "Owner there: <Safe>".
  - A non-recovery `safeExecute` to L0 is refused before any user operation.
  - "Recover funds" is one passkey-approved user operation. The Safe receives exactly `refundableOf`, and no wallet or wallet session ever appears.
  - **Negative control:** with round 1's wallet-first line temporarily restored, the same test fails with "✗ No Ethereum wallet detected…" (`logs/r2-safe-control.log`). The file was restored and its sha256 `59dcf050…` re-verified.

### Migration-procedure finding (round 2)

- A faithful replacement ledger needs `importEarn` (runner rates) as well as `importDeployments`. Otherwise a funding made on the replacement escrows nothing for an imported record, so nothing is refundable there.
- The test rig and the fork fixture now migrate with both.
- `ledger-15d-base.json` records "70/70 imported and verified; imports sealed" but not whether runner rates were imported. **Unverified; root should check it.**

## B. Round-1 content (still current; summarized, full text in `deliver/round1/`)

- **Passkey fixture timeout.** Root's stuck hash `0x68546d85…` was book `setMany`. The cause was viem 2.53.1's receipt watcher dropping the only automined block. Fixed by direct receipt polling (status still required). The `cacheTime: 0` and log-range harness fixes are also included.
  - Unchanged in round 2, apart from the new `--replace-ledger` branch and an `importEarn` step in that branch only.
  - The same latent race exists in other anvil rigs; reported, not changed.
- **Recovery allowlist.** Only exact `refund(bytes32)` and `setActive(bytes32,false)` to a replaced ledger. Create, fund, re-activate, trailing bytes, `approve(oldLedger)` and any replaced non-ledger target are refused.
- **Fresh binding check before signing.** `safeExecute` checks before passkey approvals; the passkey USDC authorization, the wallet EIP-3009 authorization and the permit are also checked.
- **Generator.** `--address-book` selects the original session factory 0x1f5c887c…; `--verify-chain` verifies the factory → implementation → book/USDC binding and the core entries.
- **Ledger replacement without import** makes existing vaults' first creates revert with `Exists()` (`SessionVault.sol:1086`). Migrations must import.
- **Vault-held escrow** on a not-yet-retired replaced ledger is not client-recoverable. After administrator `retire()`, anyone may push the refund to the vault.

## C. Test evidence (shared queue; caps 256 serial units / 1408 Chromium; 16 GiB floor; no swap)

| Round-2 run | Log (`work/browser-platform-book/logs/`) | Result |
| --- | --- | --- |
| Recovery units (first run) | `r2-unit-1.log` | 8/8 pass |
| Recovery + generator + profile units | `r2-unit-2.log` | 25/25 pass |
| Serial units: root's 7 files + mine + 15 files importing changed modules | `r2-units-3.log` (files in `units-files.txt`) | 295 tests: 289 pass, 0 fail, 6 skipped |
| Book browser (fixed and book), final code | `r2-book-browser-5.log` | **15/15 pass** |
| Safe no-wallet recovery, final code | `r2-safe-2.log` | **1/1 pass** |
| Negative control (round-1 wallet-first line) | `r2-safe-control.log` | Fails as expected |

- **The 6 skips** are opt-in live reads (`ENCLAVE_LIVE_READS=1`).
- **Book browser subtests:**
  - root's 13;
  - 5: L0 → L1 by import, existing grant on L1, per-holding owners;
  - 8: L1 transfer to the vault, funding on both ledgers, L1 → L2, cold tab with history, old-owner routing, refund on L0, the L1 balance kept after refresh, L1 retired → permissionless push to the vault, L0 retired → the vault's own record, refusals on both ledgers.
- **Development failures** (not passes; all fixed in the test or fixture, no product checks weakened):
  - `r2-book-browser-1/2`: the fixture's plain `fund` on a vault-owned record is a non-refundable gift; it now uses `fundFor` to the owner. The migration also lacked `importEarn`.
  - `r2-book-browser-3/4`: listing raced the reload's wallet re-check; the helper now waits up to 30 s for the address.
  - `r2-safe-1`: `.map(getAddress)` passed the index as a chain id.
- **Not rerun in round 2:** the passkey UI suite (`site-independent-passkey-ui.test.mjs`), as instructed.
  - Its paths are unchanged this round: its profile has no `ledgerHistory`, so the scan returns at once, and the holdings merge is a no-op without replaced ledgers. The fork fixture's default path is unchanged.
  - Its last passes (book 3/3 and fixed 3/3) were on round-1 code.
- **Also not run:** other Chromium suites, and anything in `work/enclave` itself.

## D. Remaining integration (root-owned; nothing here is done or claimed)

1. **Apply the patch** to `work/enclave` after checking `base_sha256`. Rerun in main:
   - the serial units;
   - `site-existing-contract-sessions`;
   - `site-platform-book-safe-recovery`;
   - the passkey UI suite in both modes.
2. **Generate the book-mode profile** (operator inputs announced):

   ```
   node scripts/network/browser-profile.mjs --authority contracts/deployments/network-profile-base.json \
     --expect-digest sha256:<out-of-band digest> --expect-pins contracts/deployments/contract-pins-base.json \
     --address-book 0xab214342d5a490150a4a977063a2f88e21f80907 \
     --rpc <https A> --rpc <https B> [--rpc <https C>] [--storage-plan …] [--directory https://…] \
     --verify-chain --ledger-history-from <the book's deployment block> [--log-span <RPC limit>] --out browser-profile.json
   ```

   - The output must show `sessionVaultFactory` 0x1f5c…, the binding line and one "book history" line per `AddressSet(deployments)` event.
   - Review `ledgerHistory.ledgers` against the platform's own migration records, then publish the fingerprint.
3. **Site release:** set `BUILT_IN_PROFILE_TEXT` to the exact generated text, or keep profiles user-imported with an announced fingerprint. Then follow root's site-release procedure. Regenerate the profile at each release to keep the browser's history gap short.
4. **Ledger migrations, operationally:**
   - import records **and** runner rates (verify what 15d did);
   - `retire()` the old ledger once imports are done, so vault-held escrow there becomes pushable to the vaults.

## Gap checklist (actual gaps; sources)

- **Vault-held escrow on a replaced, not-yet-retired ledger** is not client-recoverable. The vault acts on the book's current ledger (`SessionVault.sol` `L.refund`). Mitigation: administrator `retire()`.
- **Ledger replacement without import** breaks existing vaults' first creates (`SessionVault.sol:1086`). Without `importEarn`, fundings made on the replacement are not refundable there. Both are migration-procedure requirements.
- **History after `through`** relies on RPC-quorum agreement, as every read in this mode does. It is bounded per call and labeled while incomplete. Its completeness through `through` depends on the profile having been generated with `--ledger-history-from`.
- **The generator's history scan has not been run against live Base**, so the live list of historical ledgers is not established here.
- **Native client** pins stay fixed at the block their instructions were generated; native follow-the-book is out of scope.
- **Receipt race in other anvil rigs:** reported in round 1, not changed.
- **Previous `browser-default-independence` task:** superseded in direction; evidence preserved under `work/browser-default-independence/`; no result file and no passing Chromium run.
