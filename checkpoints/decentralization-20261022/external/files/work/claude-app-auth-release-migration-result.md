# App auth: production releases and legacy-account migration (2026-10-20)

**Status.**
- **jot:** complete. The production component is built from the reviewed source with the real pinned model, is
  reproducible, and passes every original feature test plus the auth suites.
- **EyesOff base:** built and tested by ROOT (`66ecfcaa…`, 42 real checks, byte-identical rebuild;
  `outputs/app-auth-review/eyesoff-production-artifact.json`). Per instruction, it was not rebuilt or retested here.
- **Legacy migration (EAB1), now including passkey-only accounts (§2.5):** an isolated candidate.
  - **Passkey-only accounts migrate through their ORIGINAL credit vault.** It is the production `EnclaveCreditVault`
    factory, verified byte-identical to its source, with no new or changed contract.
  - **jot candidate.** It passes, in a real browser against a real EVM:
    - the WebAuthn RP/origin flow, with the passkey signing on the static signer page at the vault's pinned origin;
    - rotation, revocation and every refusal asked for;
    - the wallet migration suites.
  - **EyesOff candidate.** It passes its unit tests (260/260), but its component is NOT BUILT. Two bounded windows (60
    and 30 minutes) never reached the 18.5 GiB start you set for its 1536 MiB build. Its component and browser tests,
    including the passkey branch that is written, have therefore not run (§2.6).

**What I did not do.** Nothing was committed, published, signed or deployed. No production database, key or wallet was
touched, and no file in `enclave-apps` was edited by this task.

**Requirements followed** (`work/effective-goal-requirements.txt`, 2026-10-20):
- Enclave's admin authority is retained.
- What retires is the identity SERVER, not the admin wallet.
- No contract or ownership change, and no new contract: the passkey path reuses the deployed credit-vault factory.

**Evidence.**
- Inventory: `work/app-auth-release-migration-source-inventory.json`.
- Interface: `work/app-auth-release-migration-interface.txt`.
- Candidate, tools and tests: `work/app-auth-release-migration/`.
- Every build and test went through the shared queue (`claude-test-queue.py`), with logs in
  `work/app-auth-release-migration/logs/`.
- The predecessor report and its frozen artifacts are preserved, and their unchanged tests were not repeated.

## 1. Deployable components

### 1.1 jot: production component DONE

- **Source.** The reviewed tree `enclave-apps` @ `928646f`, with all 44 files of `app-auth-final-source-inventory.json`
  unchanged.
- **Model.** The exact pinned model `minishlab/potion-base-8M` @ `bf8b0566…`. It was fetched with size and digest checks
  into the scoped cache `app-auth-release-migration/cache/`.

  | File | Bytes | sha256 (matches the pin in `scripts/fetch-model.sh`) |
  | --- | --- | --- |
  | `model.safetensors` | 30,236,760 | `f65d0f32…` |
  | `tokenizer.json` | 683,666 | `e67e803f…` |

  jot's own `fetch-model.sh` converted them, twice, with identical output:

  | File | sha256 | Notes |
  | --- | --- | --- |
  | `embeddings.i8` | `411707a1…` | 7,677,293 B, 29,528 × 256 |
  | `vocab.txt` | `1394523a…` | |

- **Build.** `cargo build --release --target wasm32-wasip2` with the crate's own release profile (`lto=true`,
  `codegen-units=1`, `opt-level=s`) and toolchain rustc 1.99.0-nightly 84b36a78a.
  - **Result:** `jot.wasm`, **sha256 `22a51a54f14b4370483670cd2e052c182fdb13611c4cb31330e22a85476bd515`**, 8,630,986 B.
  - **Reproducible.** A rebuild from an empty target directory gives the same hash. `cargo component build` (what
    `scripts/e2e.sh` runs) also gives the same hash, and leaves `src/bindings.rs` unchanged.

| Test (production component) | Result |
| --- | --- |
| `cargo test --lib`, now including the 7 model-dependent `embed::`/`index::` tests skipped last time | **58/58** |
| `scripts/e2e.sh`: every route against MinIO, including BM25 search, **semantic search** (a paraphrase ranked first with no shared term), index reconcile and reindex, conditional writes, read-only, unconfigured, per-user sealing and isolation, `X-User` rules | **ALL PASS (40 checks)**, peak 465 MiB |
| `scripts/wallet-evm.e2e.test.mjs` + `scripts/link-minio.test.mjs` (real EVM, real S3; earlier only on the stub build) | **5/5**, peak 385 MiB |

### 1.2 EyesOff: base production component built by ROOT

The root built the base EyesOff production component:
- `work/enclave-apps/eyesoff-ai/target/wasm32-wasip2/release/eyesoff_ai.wasm`, sha256
  `66ecfcaa0e4ea8301d05a975df208592215e30b2ed38c94fa42dccc717a65ca4`, 6,882,879 B;
- the unchanged release profile and pinned nightly-2026-07-25;
- a byte-identical clean rebuild, and 42/42 real production checks (attestation, service worker, warmup, sign-in,
  account continuity, real-EVM EIP-1271/6492).

The receipt is `outputs/app-auth-review/eyesoff-production-artifact.json`. Per instruction, it is not rebuilt or retested
here. Its build peaked at 1,158 MiB under the 1536 MiB cap. That settles the open question from my previous report:
1536 suffices, and no profile change is needed. Only the EAB1 CANDIDATE build of EyesOff is mine (§2.6).

**api-mcp-adapter and depot.** Their release artifacts from the previous task (`a3ba0185…`, `68c256b4…`) stay frozen: no
dependency of theirs changed.

## 2. Legacy accounts after the identity server retires: EAB1

### 2.1 What is missing, exactly (from the relay's code, no production data read)

- **Account ids.** `acct_` + 24 random hex digits (`relay/store.js` `rid`).
- **Where the binding lives.** Only in the relay's account store (`accounts.json`: `{accounts: {acct_…: {wallets[],
  passkeys[{pubX, pubY, credId}]}}, byWallet}`).
- **EST1 names no credential.** It is `{v, sub, aud, iat, exp}`.

So the missing input is precisely **each account's credential list in that store**. Nothing in app data, tokens or chain
state can reconstruct it, and nobody may guess it. Recovering it needs one private export from that store, made before
the server is retired.

### 2.2 The mechanism (`PROTOCOL-EAB1.md`)

**One historical act, at cutover.**
- The relay operator runs `tools/eab1.mjs snapshot` on the store.
- Each account's credentials become **salted** Merkle leaves; the 32-byte random salt is per account.
- Enclave's platform key (the `sso.signer` deployments already pin) signs the root statement.
- Only `{cutover, root, leaves, accounts, issued_at}` is public. It names no account, credential or pairing (tested).
- Each account gets a **private bundle**: its id, its salt, its credentials and their Merkle paths.

**Afterwards, with no identity server.**
- The bundle is an account proof (`EAB1.<base64url>`) in the apps' existing link flows, beside EST1 and EAK1.
- The app checks that every credential reaches the pinned root.
- A wallet the account had at cutover must sign the link: an EOA, a deployed contract wallet or a counterfactual
  (EIP-6492) one, through the unchanged `wallet.rs`. For a passkey, the signer is the vault derived from it (§2.5). The
  check happens at the challenge, and again on the PROVEN signer at the link.
- The result is the app's ordinary link: an ELK1 in EyesOff, MAC'd records in jot. Old keys and sealed data stay as
  they are, and nothing is copied or re-keyed.

**The authority boundary.**
- **Historical trust, once.** The snapshot is as true as the server's store at cutover, the same trust every EST1
  already carried.
- **After cutover, the former server has no role.**
  - A new snapshot binding someone else's account is a different root, so it is refused (tested).
  - `sso.until` makes every deployment refuse any EST1 after the cutover by its own clock, since a former server can
    write any `iat` (tested for sign-in and for linking).
- **Admin powers are untouched.** Owners choose what to pin with their existing config transaction. Enclave's admin
  wallet keeps contract administration and migration, catalog delisting and host bans. EAB1 adds no moderation bypass.

### 2.3 The candidate (isolated; nothing applied to `enclave-apps`)

| Piece | sha256 | What it is |
| --- | --- | --- |
| `candidate/eab1.rs` | `83508224…` | The verifier, shared verbatim by EyesOff and jot. No new dependency. `wallet.rs` is unchanged (`4619d6bb…`, identical in all four apps). It now carries the passkey-vault pin, the derivation, and the no-credential vs passkey-only distinction. |
| `candidate/apply.py` | `06a49371…` | Anchored edits to both apps. |
| `candidate/make-patches.sh` | `f8e10aad…` | Diff headers are now timestamp-free, so the patch hashes are deterministic. |
| `patches/eyesoff-ai-eab1.patch` | `8634493d…` | Applied to the current `enclave-apps` sources, it reproduces the tested candidate trees byte for byte (checked). |
| `patches/jot-eab1.patch` | `b318aa44…` | Same check. |
| App changes | — | The `migration` pin: strict, it re-checks the statement signature at parse, and has an optional `vault_factory`. Also `sso.until`; EAB1 in both link flows; the Sign-in-with-Enclave button hidden after cutover; and a "Restore … with a migration file" control in both pages. A passkey-only file goes to the hand-signed path, whose text names `https://enclave.host/recover/`. |
| `tools/eab1.mjs` | `0b0c8d51…` | `snapshot` / `attach` / `verify-statement` / `config [--vault-factory --vault-implementation]` / `vault` / `credential` / `verify`. `report.json` and the printed counts separate `no_credential` from `passkey_only`. |
| `passkey/recover/` | `index.html 0bfd0ed3…`, `recover.js a488064b…`, `recover-config.production.json 1d500953…` | The static passkey signer page (§2.5). It is a site change, proposed only. |
| depot | — | Unchanged. Owners verify a user's bundle with the tool, then list the wallet (or the passkey's vault address, from `eab1.mjs vault`) under `accounts`: still the owner's decision. |
| api-mcp-adapter | — | Unchanged: it stores nothing. |

### 2.4 Tests of the candidate

Every row below ran through the shared queue on 2026-10-20, after the passkey change. Logs are in
`app-auth-release-migration/logs/`.

| Suite | Component | Result |
| --- | --- | --- |
| jot `cargo test --lib`: the existing tests plus 7 `eab1` tests. Two are new: the vault CREATE2 vector (= viem), and no-credential refusal. The passkey-only test is rewritten: it proves only through its own vault, while another factory's, another implementation's or another key's vault, or a wallet, is refused, and the `vault_factory` pin is strict. | — | **65/65**, peak 373 MiB |
| EyesOff `cargo test --lib`: the same 7 `eab1` tests plus the existing 253 | — | **260/260**, peak 721 MiB |
| `tests/migration-evm.e2e.test.mjs`, jot part (real EVM, real MinIO) | jot candidate `b0be835e…` | **4/4** (the EyesOff test SKIPPED: no candidate component, §2.6), peak 356 MiB |
| `tests/browser-migration.mjs`, jot (real Chromium; the page's own file picker; browser wallet and hand-signed 6492) | same | **PASS ×2**, peak 1193 MiB |
| **`tests/passkey-recovery.mjs`, jot** (real Chromium WebAuthn, real EVM with the production-source vault, §2.5) | same | **24/24**, peak 1338 MiB |
| `passkey/check-production-derivation.mjs` (read-only, Base, two RPCs) | live factory | **OK**: live `implementation()` = pin; live `vaultFor` = derived for 3 random keys (block 52859909) |

**jot candidate component.** `scratch/apps/jot/target/wasm32-wasip2/release/jot.wasm`, sha256
`b0be835e9d33f9812c1fb78501956805d0ed7f46c2a201defa9270fd8efff724`. It has the production profile and the real model,
and was built `--locked --offline`. It supersedes `b2d4adab…` and `82f69b05…`.

**Covered on jot's real component (wallets):**
- EOA, deployed and counterfactual wallets restore their accounts' sealed notes after cutover, with no SSO server.
- EST1 replay after the cutoff is refused, for sign-in and for linking.
- A wrong wallet is refused, including a link message the attacker builds and signs themself.
- Corrupted bundles are refused: a flipped path node, an edited account or salt, a truncated file.
- A former server's new snapshot is refused.
- Failure and resume, restart persistence, on-chain revocation, and a statement that leaks no mapping.

### 2.5 Passkey-only accounts (PROTOCOL-EAB1.md §3a)

**Reuse of the ORIGINAL contracts, verified against source and deployed pins.**
- **The binding.** The relay binds an account's first P-256 passkey to its credit vault: `relay/auth.js`
  `vaultKeyOf`, then `relay/vaultsvc.js` `vaultAddressFor`, which reads `vaultFor(x, y)` from the factory at book key
  `vaultFactory`.
- **The factory.** That factory, `0xa891e4396e3eb11f364554043bc18e86da834e91`, and its implementation,
  `0xeca6644333d3a069001203ce5416914a4d830beb`, were checked read-only. Two public RPCs agreed at block 52856571
  (`passkey/match-history.mjs` -> `passkey/production-factory.json`, `dc19f3eb…`).
  - **Source match.** Both are byte-identical, immutables masked and CBOR metadata included, to
    `contracts/EnclaveCreditVault.sol` at `d36100ae`, sha256 `b9788969…934c`. The compile used the deploy pipeline's
    settings: solc 0.8.35, optimizer 200, no viaIR. An earlier comparison against the foundry (viaIR) artifact did
    not match: those are not the deploy settings.
  - **Decoded immutables.** `origin0 = "https://enclave.host"`; `origin1` is unused; there is no recovery admin. `usdc`,
    `book` and `treasury` are as recorded.
- **The signature rule.** The vault's `isValidSignature` is ERC-1271 over a WebAuthn assertion. It requires an active
  key, user presence, and a clientDataJSON head with the challenge and EXACTLY that origin. An undeployed vault
  verifies through ERC-6492 with `createVault(x, y)`.
- **Why not SessionVault.** `SessionVault` is deliberately not ERC-1271 (`contracts/SessionVault.sol`), so it cannot
  sign as an account. The credit vault can, and it is the vault the relay already ties to the account's passkey.
- **What is new.** The app-side pin, the derivation and the static page. There is no contract change and no deployment.

**The WebAuthn RP/origin constraint, addressed explicitly.**
- **Where the passkeys work.** The relay's passkeys are on rpId `enclave.host`. A tenant page (`*.app.enclave.host`)
  can obtain an assertion, but it carries the tenant's origin, and the vault refuses it. That anti-phishing rule stays.
- **The signer page.** Recovery signing therefore happens on a STATIC page at `https://enclave.host/recover/`
  (`passkey/recover/`). It needs no server, account store or issuer. It reuses the site's `/vendor/aa.js`, whose ox
  `WebAuthnP256` is the browser passkey signer the dashboard's passkey account already uses.
- **What the page does.**
  - It derives and shows each committed passkey's vault address.
  - It signs only SIWE text that names an `urn:enclave:deployment` and that passkey's own address. It never signs a raw
    digest, so it cannot authorize `addKey` or a refund.
  - It outputs ERC-6492(factory, `createVault(x, y)`, `WebAuthnSig`).
- **Production pins.** The production config is `{origin: https://enclave.host, rpId: enclave.host, factory,
  implementation}`.
- **Fit with the site.** The page has no inline script, so it fits the site's release CSP unchanged. The site build's
  explicit file list (`scripts/build-site.mjs`) must add it: a main-repo change for the site owner, not made here.

**What the app does.**
- **The pin.** Owners pin `migration.vault_factory {address, implementation}`.
- **The derivation.** `eab1.rs` DERIVES each committed passkey's vault address and accepts only those, or committed
  wallets. The address is never taken from the request.
- **The signature.** It goes through unchanged `wallet.rs` and the pinned reader quorum.
- **The two refusals are now distinct:**
  - "commits no credential this deployment can check" (an account with NO credential is not even in the snapshot; the
    tool reports it);
  - "commits only passkeys, and this deployment pins no passkey-vault factory".

**Verified in a real browser against a real EVM** (`tests/passkey-recovery.mjs`, jot candidate `b0be835e…`, 24/24).
The rig is:
- **The browser.** Chromium's CDP virtual authenticator (ctap2, internal, user verification) holds three P-256
  credentials on RP `localhost`. Every assertion is a genuine browser WebAuthn assertion for the page's own origin; the
  test never signs P-256 itself.
- **The chain.** `anvil --network optimism`, which has the RIP-7212 P-256 precompile that Base has. On it, the
  d36100ae factory compiled with the deploy settings is deployed with `origin0` = the local signer page's origin.
- **The store.** A synthetic relay store holds a passkey-only account with two passkeys, a wallet account, and an
  account with no credential.

Checks:
- **No credential vs passkey-only.** The no-credential account is reported and not committed. The passkey-only account
  is committed, and the tool derives its two vault addresses.
- **One formula.** The tool, the page and the deployed factory's `vaultFor` agree on the address.
- **The legitimate flow** goes through the app's real page (Restore → file → hand-signed path) and the signer page
  (file → address → message → passkey prompt → signature):
  - the account is linked to its vault address, with no issuer;
  - a later sign-in with the passkey acts as the account;
  - the sealed note written before cutover reads back;
  - the vault was never deployed (ERC-6492 only).
- **Refused:**
  - a vault derived from a passkey the account never had (at the challenge);
  - a stranger's passkey signing as the account's vault (wrong credential);
  - the account's OWN passkey asserting from ANOTHER origin;
  - an ERC-6492 wrapper whose factory call deploys a different vault (counterfactual refusal);
  - a message naming another address (the signer page refuses);
  - a former issuer's new snapshot (issuer replay);
  - a post-cutoff EST1.
- **Rotation and revocation on the original contract.**
  - After `createVault` and an on-chain `addKey` signed by the root passkey at the pinned origin, the added passkey
    signs as the account.
  - After `removeKey` signed by the added passkey, the removed passkey's EARLIER session is refused on its next
    request, and so is its fresh signature, while the remaining key still opens the account.
- **The second committed passkey.** It shows its own address on the page and is accepted at the challenge. jot's
  existing one-wallet-per-account rule then refuses a second link (409), unchanged. Its second device joins the vault
  through `addKey` instead.

The positive controls (the rotated key, and the root key before revocation) use the same assertion path as the
refusals. So the refusals come from the vault's checks, not from a broken signer.

**What this does not cover.**
- **The real `enclave.host` origin.** The flow cannot be exercised there without serving the page on the production
  site, which is a site deployment. The production pins were instead checked read-only: the live factory's
  `implementation()` and `vaultFor` equal the app's derivation (`passkey/check-production-derivation.mjs`).
- **The site.** A passkey cannot be used away from its RP, so passkey-only migration depends on the site serving the
  static page. A holder who wants a credential independent of that origin links a wallet, which still works.
- **Releases from the custodial archive.** For passkey-only bundles this is a written procedure (ACTIVATION-PLAN
  Phase E), not tested code.

### 2.6 EyesOff candidate component (EAB1 + passkey)

**NOT BUILT, so the EyesOff candidate's component tests have NOT RUN.**

**What ran.**
- The candidate tree applies cleanly and reproduces from `patches/eyesoff-ai-eab1.patch` byte for byte.
- It passes `cargo test --lib`, 260/260, including the 7 shared `eab1` tests.
- `eab1.rs` and `wallet.rs` are byte-identical to jot's, and those are what the jot component exercised end to end.

**Why it was not built.** The production-profile build needs the 1536 MiB allocation, and you set the start condition
at >= 18,944 MiB (18.5 GiB) available. I ran it behind a bounded gate (`scratch/eyesoff-candidate-build.sh`, the shared
queue inside) for two windows: 60 minutes, then 30 minutes. Available memory stayed between about 17,240 and 18,440
MiB, with 17,894 and 17,839 MiB at the two timeouts. Nothing was submitted, and I did not lower the guard.

**What is ready for when memory allows.**
```
GATE_SECS=3600 work/app-auth-release-migration/scratch/eyesoff-candidate-build.sh
```
It uses the same command and profile as the root's base build, which peaked at 1,158 MiB. Then:
- `tests/migration-evm.e2e.test.mjs`, whose EyesOff test is now skipped only for want of `EYESOFF_WASM`;
- `ONLY=eyesoff tests/browser-migration.mjs`;
- `ONLY=eyesoff tests/passkey-recovery.mjs`. This is the EyesOff branch: post-cutoff EST1, a stranger's vault, a
  stranger's passkey, another origin, a wrong 6492 factory call, then the real UI. The UI part is a gate sign-in as the
  vault through "another signer" and the signer page, then API panel → restore file (a passkey-only file goes to the
  hand-signed path), then `/v1/keys` returning the account's PRE-cutover API key. It is written and syntax-checked, NOT
  run.

**Old artifact.** `scratch/apps/eyesoff-ai/target/…/eyesoff_ai.wasm` (`2fbaba91…`, 2026-10-19 16:51) predates these
changes and is not a candidate.

## 3. What remains (root and owners), unsigned

1. **EyesOff candidate component and its tests** (§2.6). From `app-auth-release-migration/`:
   ```
   EYESOFF_WASM=…/scratch/apps/eyesoff-ai/target/wasm32-wasip2/release/eyesoff_ai.wasm \
     JOT_WASM=…/scratch/apps/jot/target/wasm32-wasip2/release/jot.wasm node --test tests/migration-evm.e2e.test.mjs
   ONLY=eyesoff EYESOFF_WASM=… node tests/browser-migration.mjs
   ONLY=eyesoff EYESOFF_WASM=… node tests/passkey-recovery.mjs      # the EyesOff passkey branch, written, see §2.6
   ```
2. **Root review.** Review EAB1, `passkey/recover/`, and the `patches/*.patch` (they regenerate deterministically with
   `candidate/make-patches.sh`). Apply the patches to `enclave-apps`, rebuild jot (the candidate hash becomes the
   release) and EyesOff, and publish new versions with the publisher wallet.
3. **Site owner.** Serve `passkey/recover/` at `https://enclave.host/recover/` (ACTIVATION-PLAN Phase A).
   - Add the three files to `scripts/build-site.mjs`.
   - Re-run `passkey/match-history.mjs` and `passkey/check-production-derivation.mjs` (read-only) first.
   - Then check one real passkey in a browser at that origin: its shown address equals `vaultFor`, and a jot or EyesOff
     test deployment pinned with `vault_factory` accepts its sign-in. This is the one step of the RP/origin flow that
     only the production origin can show.
4. **Before cutover** (ACTIVATION-PLAN Phase A):
   - owners set `sso.until`;
   - freeze account creation and linking at T.

   Passkey-only holders need no wallet. They may still link one.
5. **At cutover:**
   - snapshot, then `attach`, then publish;
   - owners `verify-statement` and pin the `migration` block WITH `vault_factory` (`activation/migration.example.json`,
     unsigned);
   - depot and api-mcp-adapter owners remove `sso` at T.
6. **Delivery, which must happen before retirement.**
   - A relay endpoint proposal: `GET /v1/account/migration-bundle`, plus a sign-in banner.
   - Afterwards, an encrypted offline archive releases a bundle on a fresh signature from a committed wallet, or from a
     committed passkey's vault.
7. **Cannot be migrated by anyone.**
   - Accounts with no credential at all (listed privately in `report.json` `no_credential`).
   - Data under bare `0x` subs, if any exist. None are expected: the relay only mints `acct_` subs. Flagged, not
     guessed.
