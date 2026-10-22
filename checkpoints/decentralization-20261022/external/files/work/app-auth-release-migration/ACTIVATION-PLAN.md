# App auth release and EAB1 migration: activation plan (v1, 2026-10-19)

**Status: nothing here has been executed.** No production config, account store, key or chain was read or written.

Every signature below is an OWNER or OPERATOR action, prepared unsigned. Times are placeholders:
- `T`: cutover, the moment EST1 stops counting everywhere;
- `R`: issuer retirement, `T` + the notice period.

The protocol is in `PROTOCOL-EAB1.md`.

**Authority is unchanged (2026-10-20 requirements).** Retirement here means the identity SERVER (relay accounts and SSO),
not Enclave's administration. Every signature in this plan is one Enclave or an owner already makes today:
- the platform key signs the statement;
- the publisher wallet publishes versions;
- owners sign their own config transactions.

No contract, ownership, admin right, catalog policy or host ban is touched, and no new contract is deployed. Rollback is a
config change.

## Inputs

| Input | Where |
| --- | --- |
| Candidate patch (eyesoff-ai, jot) | `candidate/apply.py` (anchored edits) + `candidate/eab1.rs`; `patches/*.patch` generated from them against the reviewed tree |
| Production components | `../claude-app-auth-release-migration-result.md` §1: hashes, toolchains, build commands |
| Operator tool | `tools/eab1.mjs` (`snapshot`, `attach`, `verify-statement`, `config`, `credential`, `verify`) |
| Config fragments | `activation/*.json`: unsigned, merged into each deployment's existing app config |

## Phase A: before T (publish, pre-commit the cutover, tell people)

1. **Root review.** Review `candidate/` and `patches/`, then apply them to `enclave-apps` (eyesoff-ai, jot). Review
   `passkey/recover/` (the static passkey signer page, PROTOCOL §3a).
2. **Build and publish.**
   - Build the production components with the documented commands, and compare hashes with the result report's
     reproducibility record.
   - Publish new catalog versions of eyesoff-ai and jot with the publisher wallet (`enclave publish …`, unsigned until
     the publisher signs).
   - depot and api-mcp-adapter have no migration code. Their current release artifacts stand.
3. **Deploy and pre-commit `T`.** Each owner deploys the new versions and sets their config with
   `enclave config set <id> --file <merged config> --unsigned`. The owner signs the printed transaction with their own
   wallet; that is the only signature here. The config adds:
   - `sso.until = T` (`activation/sso-until.json`): eyesoff-ai and jot refuse every EST1 from `T` by their own clock,
     whatever a token claims about itself.
   - `wallet` with `contract_wallets` (readers on distinct hosts, `quorum` > half), if not already set.
   - jot: `link_key` (or rely on `master_key`); EyesOff: keep `api_key_seed`.
4. **Notice period: the actions §5 of the protocol requires before retirement.**
   - **Site owner: serve the passkey signer page**, so passkey-only accounts can migrate (PROTOCOL §3a). It is static:
     copy `passkey/recover/index.html` and `recover.js` to `https://enclave.host/recover/`, with
     `recover-config.production.json` served as `recover/recover-config.json`. It uses the site's existing
     `/vendor/aa.js`. It must be at exactly `https://enclave.host`, the origin the live vault factory pins.
     - The site build copies an explicit file list (`scripts/build-site.mjs`), so the site owner adds the three files
       there. That is a main-repo change I did not make.
     - The page has no inline script and loads only same-origin modules. It therefore fits the release CSP as it is
       (`script-src 'self' …`, `connect-src 'self' https:`), with no new hash.
     - Before serving it, re-run `node passkey/match-history.mjs` (read-only). It must still report the match at
       `d36100ae`, `origin0 = https://enclave.host`, and the factory and implementation in the config.
     - Then check it in a browser with an existing passkey: the address it shows for a passkey must equal the factory's
       `vaultFor(x, y)`.
   - Optional for passkey-only holders: linking a wallet still works too (relay `/v1/account/link/siwe`). It is the way
     to have a credential that does not depend on the `enclave.host` origin.
   - Freeze account creation and wallet linking at `T` (relay operator). An account or link made after the snapshot is
     not in it.
   - Relay owner, a proposal (not applied): `GET /v1/account/migration-bundle`, account-session authenticated, returns
     that account's `bundles/<acct>.json`, available from `T` to `R`. Show a "download your account migration file"
     banner at every sign-in in that window.

## Phase B: at T (the one historical act)

1. **Snapshot.** The relay operator, on the relay host, with account creation frozen, runs:
   ```
   node tools/eab1.mjs snapshot --accounts <relay data dir>/accounts.json --cutover enclave-<YYYY-MM-DD> --out <private dir>
   ```
   It prints only counts and the root. `bundles/` and `report.json` stay private (0600).
2. **Sign.** The platform SSO key (the key in every `sso.signer`) signs `statement.json`'s `text` with EIP-191
   personal_sign, using the operator's own signer. Then:
   ```
   node tools/eab1.mjs attach --statement statement.json --signature 0x… --signer <sso signer>
   ```
3. **Publish** `statement.json`, which is public, wherever owners fetch from (for example
   `https://enclave.host/.well-known/eab1-statement.json`, beside `sso-signer.json`).

## Phase C: at or after T (owners pin the snapshot)

1. **Verify.** Each owner checks the statement against the signer they already pin:
   ```
   node tools/eab1.mjs verify-statement --statement statement.json --signer <their sso.signer>
   ```
2. **Pin.**
   ```
   node tools/eab1.mjs config --statement statement.json \
     --vault-factory 0xa891e4396e3eb11f364554043bc18e86da834e91 \
     --vault-implementation 0xeca6644333d3a069001203ce5416914a4d830beb   # prints the "migration" block
   ```
   The two vault flags pin the address book's passkey-vault factory and its implementation. Read them from the book
   (`vaultFactory`) and the factory's `implementation()` at the time, which is what `passkey/production-factory.json`
   recorded at block 52856571. Without them, passkey-only accounts are refused with a reason naming the missing pin.
   Merge the block into the app config (`activation/migration.example.json` shows the shape), then
   `enclave config set <id> --file … --unsigned` and the owner signs it. Pinning the `signer` and `signature` with the
   block means the app re-checks the statement at parse, so a typo is caught before anyone migrates.
3. **depot.** Remove the `sso` block (depot has no `until`). For each existing user who asks, the owner runs:
   ```
   node tools/eab1.mjs verify --statement statement.json --bundle <their file> --wallet <their wallet>
   ```
   Then the owner lists `wallet_<addr>` under that user's `accounts`, after the wallet signs any message the owner
   chooses (it is the owner's decision, as always).
4. **api-mcp-adapter.** Remove `sso` at `T`. It stores nothing; callers name themselves per request.

## Phase D: after T (users migrate, any time, no issuer)

**EyesOff:** API panel → "Keep your Enclave account with a wallet" → "Restore your account with it". Choose the file,
then sign with a wallet the account had: in the browser, or "with another signer" (Safe, hardware, CLI, a passkey
account). The wallet then acts as the account, with the account's existing API key. To move to a newer wallet later,
link it with that API key.

**A passkey-only account** (either app): the app sends the file to "another signer".
1. Open `https://enclave.host/recover/` and choose the same file there. It shows the passkey's account address.
2. Enter that address in the app, then paste the app's message into the signer page.
3. Approve the passkey prompt, and paste the signature back into the app.
4. The passkey's vault then acts as the account. To sign in later, repeat steps 1-3 with the app's sign-in message.

**jot:** sign-in card → "Restore an account…" → choose the file → sign. The wallet opens the account's existing sealed
notebook.

**No issuer is contacted. A lost bundle:**
- EyesOff: the account's API key still links.
- Otherwise: the custodial archive (Phase E).

## Phase E: at R (retirement)

- The relay's identity endpoints stop.
- **Bundles never downloaded:**
  - The operator encrypts the bundle set at rest and keeps it offline.
  - It releases a bundle only on a fresh EIP-191 signature, from a wallet that bundle commits, over
    `"Release my Enclave account migration file, cutover <id>, <date>"`. The signature is checked with
    `tools/eab1.mjs verify` and wallet.rs's rules, and the request is answered privately.
  - **A passkey-only bundle** is released on its passkey vault's signature instead.
    - The custodian already holds the bundle, so it derives the vault with `eab1.mjs vault`.
    - It gives the holder a Sign-In-with-Ethereum release message naming that address and
      `urn:enclave:deployment:eab1-custodian`. The signer page signs only that form.
    - It checks the ERC-6492 signature through chain readers, as the apps do. The custodian sends the file, not the
      page: the page only reads a file the holder already has. This step is procedure, not tested code.
  - The custodian can delay or refuse; it cannot bind, because the root is pinned.
- Destroy the snapshot salts that were delivered? No: bundles are the users' to keep. The operator's copy is the archive.

## Failure and resume

| Step | If it fails | Resume |
| --- | --- | --- |
| Snapshot | the tool refuses an inconsistent store; nothing is written on error | fix the store, rerun (new salts, new root) |
| Signing | `attach` refuses a signature that does not recover to the signer | sign again |
| Pinning | a config with a wrong root or signature fails to parse: the deployment reports a configuration error and honours nothing | correct the block and set it again; nothing was linked meanwhile |
| A user's link | refused with the reason (wrong wallet, corrupted file, reader quorum unavailable); nothing is written | retry; a jot link interrupted halfway is completed or replaced by compare-and-swap on the next proven attempt (link.rs) |
| Rollback | owners remove `migration` (and may restore `sso` without `until` while the issuer still exists) | links already made stay valid (they are the apps' ordinary links) |
