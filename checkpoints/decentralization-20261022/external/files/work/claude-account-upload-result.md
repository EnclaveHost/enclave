# Wallet-free Startup uploads: smart-account (ERC-1271) upload authorization — result

Browser/identity workstream (Claude), 2026-10-19. The interface is `work/account-upload-interface.txt`; section 6 is the
addendum written during implementation.

The account-first round (`work/claude-account-first-result.md`, `work/browser-final-source-inventory.json`) is untouched
and still frozen. This round closes that round's blocker 1: a passkey account (Safe) could not authorize a storage
upload, so a wallet-free dashboard could not publish startup settings.

Process: no commits, staging or reset. No production changes, SSH, real keys, wallet requests, GUI or Wine. No other
worker's process was touched. No release was activated, and the management vendor bundle was not rebuilt.

## What was built

### Adapter (`work/enclave-apps/s3-ipfs-adapter`)

**The v2 scheme.** A new, explicit scheme sent as `x-upload-scheme: erc1271-v2`.

- The signed message is `enclave-storage-upload:v2`. It binds:
  - `scheme:erc1271`;
  - the adapter's configured chainId;
  - the adapter's deployment id (`walletAudience`);
  - `method:POST`, the route path and the account;
  - the body's sha256 and byte count;
  - a 128-bit nonce;
  - the expiry, at most 900 s ahead.
- The EIP-191 digest of that text is what is passed to `isValidSignature(bytes32,bytes)`.
- A v1 message can never be read as v2, nor the reverse. Both are pinned by a unit test.

**Chain trust is the operator's own.** It is set in `upload.contractWallets`: chainId (default 8453), 2–7 distinct
reader hosts, quorum ≥ 2, plus confirmations, max_age_secs, timeout_secs and max_bytes.

- It is absent by default, and then v2 gets 401. An invalid block is logged and leaves v2 off.
- Verification is the shared, reviewed `check_1271`, which reads the full snapshot (number, hash, time, verdict) at one
  agreed block. It approves only when a single valid snapshot reaches quorum, so one reader can neither approve nor
  veto, and a split refuses.
- Freshness is judged after the reads.
- The check is copied verbatim into `src/contract_wallet.rs` from `jot/src/wallet.rs`, sha256 `4619d6bb…`, which is
  identical in all four apps and unchanged at the end of this round. A test pins the copy's body hash. The four apps'
  `wallet.rs` were not edited, so no integration patch to their owners was needed.

**Undeployed accounts are refused honestly.**

- An address without code gets 403.
- An ERC-6492-wrapped signature gets 401 "deploy the account first".
- The dashboard deploys the account through its normal path first. Both browser tests do this before any upload.

**Replay, budget and scope.**

- Each (account, nonce) is single use until its expiry: a second use gets 409. The nonce is marked only after success.
- Chain checks are limited to 30 per minute globally (429 beyond).
- Every one of these checks runs before any body byte. The body's hash and size are checked at completion, as for v1.
- A scheme header next to an `x-upload-token` gets 401. A refused v2 request never falls back to v1, HMAC or unsigned mode.

**Unchanged.** v1 EOA uploads, the legacy relay HMAC token, and every existing route and response. There is no relay,
issuer or service signer.

**Gateway CORS (found by the real-adapter browser test).** `GET /ipfs/<cid>` sent no CORS headers. That made the
browser's mandatory exact-byte readback, and its read of committed settings, impossible cross-origin for any dashboard,
v1 included. The rig's stand-in adapters had hidden this.

- Now an origin listed in `upload.allowOrigins` may read:
  - matching is exact, with no fallback to the first origin, no `*`, and no credentials;
  - GET/HEAD echo the origin and expose `content-range`, `content-length` and `etag`;
  - `OPTIONS /ipfs/*` allows `range` and `cache-control`.
- Mechanism: a one-response header slot `httpd::Server::next_extra`. `main.rs` sets it only around the synchronous
  `gateway()` call and clears it afterwards. Every gateway path responds synchronously, and `respond`/`respond_stream`
  `take()` the slot, so it can reach at most one response.

**README.** It has two new sections: the smart-account protocol with the `upload.contractWallets` config, and gateway
reads from a dashboard.

### Browser (`work/enclave`)

- **`site/js/core/upload-auth.js`**: `ACCOUNT_UPLOAD_SCHEME`, `accountUploadMessage(...)`, and
  `accountUploadDigestHeaders(...)` (https only, random nonce, expiry now+300).
- **`site/js/core/passkey-account.js`**: `accountUploadSigner({profile, passkeys, keySigner, keyAddress, getFn})`
  returns `{kind:"erc1271", account, chainId, sign}`. `sign` is `safeApprover(...)` over
  `safeMessageHash(safe, chainId, eip191(message))`: the Safe's own ERC-1271 bytes, the same path the session grant uses.
- **`site/js/core/sessions.js`**: `accountUploadSigner()` adds the verified-identity approvals. This is a pure append;
  stripping it restores the frozen hash `0d749118…`.
- **`site/js/core/storage-plan.js`**: `publishToPlan` takes either signer kind. The EOA `{address, signMessage}` path
  (v1) is unchanged.
- **`site/components/deployments/deployments.js`** (Startup tab):
  - Under a passkey-account identity, the account signs each upload itself (v2), with the status "your passkey account
    signs each upload itself (ERC-1271)", and the form says "Publishing asks your passkey account to approve once per
    storage adapter".
  - Under a wallet identity, it is unchanged: the wallet signs (v1).
  - A connected wallet is never presented as the account, and no longer signs uploads for an account's record.
  - The commit stays the account's own transaction, paid by its gas choice.
- **`test/helpers/independent-browser-rig.mjs`**: the stand-in adapters accept v2 (`isValidSignature` through the rig's
  client, with replay memory), record `scheme`, and allow the new CORS headers.

## Source closure

`git` column: `M` = modified vs HEAD, `??` = untracked.

### `work/enclave`

HEAD is `abe86262…` (`work/account-upload-baseline/enclave-HEAD.txt`).

| file | git | before sha256 | after sha256 |
|---|---|---|---|
| site/js/core/upload-auth.js | M (clean before) | bf0c55df997b… | e72157590a00d634f7301e5bba2741901f0ec107235d7298ccccace12a265d23 |
| site/js/core/storage-plan.js | ?? | 56418be7af8c… | f681e48327d85c3c667bf892d22f4d46935318ea72c329d2356dfc37ab2abc52 |
| site/js/core/passkey-account.js | ?? | 86c9de90ae7b… | f8c1ae998b40c05551c5320affa1385c98a6b2078644fe41b1af52df44298e3f |
| site/js/core/sessions.js | M | 0d749118e5e6… (frozen inventory) | 52ebf750a25dd5196655277b1a7b1da5de222df98867d42591617fbbbf84bee5 |
| site/components/deployments/deployments.js | M | e8ddb1dc7979… | 9945da46c095fe6ec8b1eed75269938c5ac03669c6a9cc2062b5883c8b1e2032 |
| test/helpers/independent-browser-rig.mjs | ?? | 47c78feb44b0… | 79eba8516787a7d3485df04d2af30fc9ffd3dee7f32f30fe9ddf2aafe38f7d8c |
| test/site-independent-account-startup.test.mjs | ?? | f18d2ee7efbb… (frozen inventory) | 26e00caa4d3fca0808608cffb6e8129a4b501930708502df6d6efb1acd858dee |
| test/site-independent-browser.test.mjs | ?? | f7d1f035749a… (frozen inventory) | e1d43468267a0a9fa46090c72968bb3d994bbd1ab98517182612b0d0abf6fcaa |
| test/site-independent-account-upload-adapter.test.mjs | ?? (new) | — | ab87fd44cdd2036cd6466779375677206d804572ca65bc5a3108cfed6de08fe1 |
| test/site-independent-account-startup-nowallet.test.mjs | ?? (new) | — | 5909df3c73a83b170d1cb33b0e3fa63e6880b044b99f1f87b663ef8f255c905a |
| test/site-independent-storage.test.mjs | ?? | dc4c0fa1… | unchanged |

Authorship of the pre-existing dirty state:

- `deployments.js`, `sessions.js`, `storage-plan.js`, `passkey-account.js`, the rig and the three earlier test files are
  this workstream's from earlier rounds (see the frozen inventory).
- This round's changes are confined to:
  - the upload-signer branch and one form sentence in `deployments.js`;
  - appended functions in `upload-auth.js`, `passkey-account.js` and `sessions.js`;
  - the signer kinds in `storage-plan.js`;
  - the v2 stand-in in the rig;
  - the startup and browser test assertions.

### `work/enclave-apps/s3-ipfs-adapter`

HEAD is `928646fc…`. The baseline copies, hashes and the pre-existing diff are in `work/account-upload-baseline/`. My
complete patch against the baseline is `work/account-upload-baseline/claude-account-upload-adapter.patch` (sha256
`68f6ee95bdc4478853a1ced69a61c6e5260b2619df5fb98ba087983bd6f9ca39`).

| file | git | baseline sha256 | after sha256 |
|---|---|---|---|
| README.md | M | 64df8a271342… | 0413f7e1eb56a41e05c45c0f7ab0598ecabcdb2e5fc27995c64bca04f2fc1cd0 |
| src/main.rs | M | 2ae4bba002e4… | 3bbe166b72af162460cc32757580ac94d65a451aa38c8ce4037e752da1474973 |
| src/upload.rs | M (clean before) | 394dd9ddb002… | 7a8d1e86ef8f7f821d488cfe7754c3ba3cd25fdbb35fcd6804e006933cf1c82f |
| src/httpd.rs | M (clean before) | 86f9c3192605… | d9a3ff7f59baa726539145bc3814221c8c1c47edaecaa54abed9803fe3ee551e |
| src/account_upload.rs | ?? (new) | — | 22f31617c2a0d3addc08166559082ac90ce1b20b479a4e5ae506693302b7871b |
| src/contract_wallet.rs | ?? (new) | — | 747439f77456d23577da22b191dd2821a906e5f76885d9f2a22edf49c3c5a4fd |
| Cargo.toml / Cargo.lock / wallet_upload.rs / egress.rs | clean | — | unchanged |

The pre-existing dirty work in README.md and `src/main.rs` (another worker's `allowOrigins` change) is preserved. All 8
of its removals and 154 of its 155 added lines are present verbatim. The remaining line is in that worker's test
`UploadCfg` literal (`json_per_ip_hourly: 60.0,`): it now ends with `contract_wallets: None,`, the field the struct
requires to compile. Their `allowOrigins` paragraph in README.md was not edited.

`contract_wallet.rs` copies `jot/src/wallet.rs` (sha256 `4619d6bb1fcf…`, the same in eyesoff-ai, jot, depot and
api-mcp-adapter, and unchanged at the end of this round). The copied body's sha256 is
`f25c4e669b7906140e954cf20c54e8f91a0624eeceb8a92a2a54d3c96693173f`, pinned by a test.

## Built component

`enclave-apps/s3-ipfs-adapter/target/wasm32-wasip2/release/s3-ipfs-adapter.wasm`:

- sha256 `132ba32f4580795eab1cbfcaaf20b06af2aa79f2870d3a136b952eb6395510d7`;
- 1,578,673 bytes;
- built with `cargo build -j 2 --release --target wasm32-wasip2` from the final sources above. Only README.md changed
  after the build.

It supersedes this round's earlier build `df7ec730…`, which had v2 but not the gateway CORS. Not deployed anywhere.

## Tests

Every run was in the foreground, one at a time, under `systemd-run --user --scope -p MemoryMax=<cap> -p
MemorySwapMax=0` plus `test/helpers/memory-guard.mjs --max-rss-mib <cap> --floor-available-mib 16384`. A wrapper,
`/tmp/claude-guarded.sh`, waits for at least 18432 MiB available before starting.

### Final source

| command | cap | result | exit | peak RSS |
|---|---|---|---|---|
| `cargo test -j 2` (adapter, native) | 1024 | 75/75 (9 new: 8 v2, 1 gateway CORS) | 0 | 368 MiB |
| `cargo build -j 2 --release --target wasm32-wasip2` | 1024 | built `132ba32f…` | 0 | 619 MiB |
| `node --test test/site-independent-account-upload-adapter.test.mjs` (real wasm adapter `132ba32f…`, minio, Base fork, 3 reader proxies) | 1024 | 5/5 | 0 | 410 MiB |
| `node --max-old-space-size=256 test/site-independent-account-startup-nowallet.test.mjs` (Chromium, no `window.ethereum`, real wasm adapters) | 1408 | 1/1 | 0 | 1149 MiB |
| `node --max-old-space-size=256 test/site-independent-account-startup.test.mjs` (account plus payer wallet, rig) | 1408 | 1/1 | 0 | 1010 MiB |
| `node --max-old-space-size=256 --test-name-pattern="profile import\|publish through the real form\|deploy and fund on the pinned ledger\|owner startup settings\|nothing reached Enclave" test/site-independent-browser.test.mjs` (wallet-only Startup path and its prerequisites) | 1408 | 5/5 | 0 | 1099 MiB |
| `node --test --test-concurrency=1` account-sessions, passkey-account, identity, storage, owner-signature, config-override-plan, dashboard-host-auth, dashboard-tls-status, deployment-move, models-read-only, pricing, runlog-retry, site-ledger-calls, site-list-failure | 512 | 184/184 | 0 | 225 MiB |
| `node --test test/site-independent-bundle.test.mjs` (esbuild of the site including `deployments.js`; temp output only) | 512 | 2/2 | 0 | 159 MiB |

What the tests cover:

- **Component test** (`account-upload-adapter`), against the real wasm adapter with a Safe whose passkey owner is a
  software authenticator:
  - v2 accepted and stored byte-exact; replay gets 409;
  - refusals: expired (401), too far ahead (401), wrong path (403), other bytes, other account (403), other chain
    (403), other service/deployment (403), invalid signature (403), PUT;
  - undeployed account: 403; 6492-wrapped: 401 "deploy the account first"; it works after its normal deployment;
  - readers: one lying "valid" reader is outvoted (403), and the honest two still approve; a split refuses ("did not
    agree"); too few readers refuse; every reader is asked;
  - v1 EOA and the legacy token still upload; scheme plus token gets 401.
- **No-wallet browser test**, with no `window.ethereum` and no wallet session:
  - the account creates itself through the owner's local bundler and the real EntryPoint v0.7 (Base fork, pinned Safe
    passkey code), paying its own gas;
  - it becomes the identity and creates a prepare-only record it holds itself;
  - the Startup tab publishes to two real wasm adapters. They have distinct audiences and are reached over HTTPS at
    distinct hostnames (`127.0.0.1` and `localhost`). Their `contractWallets` readers are two loopback pass-throughs,
    and both are asked;
  - each adapter accepts exactly one `/add-json` with `x-upload-scheme: erc1271-v2`, `x-upload-address` equal to the
    Safe, and contract-signature bytes;
  - "2 of 2 storage adapters hold the exact bytes"; the commit is exactly one user operation from the Safe;
  - the committed package verifies against `sdk/bootstrap/package.mjs` with owner equal to the Safe, from both
    adapters' gateways;
  - the browser's own authorization, replayed, gets 409; sent to the other deployment, it gets 403;
  - no page errors and no enclave.host request.
- **Account plus payer browser test**: every upload has `signer === safe` and `scheme === "erc1271-v2"`, and the text
  never says "signed by your wallet". The payer wallet only paid the deployment gas.
- **Wallet-only browser test**: the wallet identity's uploads are v1, signed by the wallet key (new assertion).

### Superseded runs, disclosed

- Component test, first run: 1/5. The fork's block time was historical, so the readers' agreed block was stale. The fix
  was `evm_setNextBlockTimestamp(now)` in the test; the next run gave 5/5. Earlier `cargo test` gave 74/74, and the
  earlier wasm `df7ec730…` was built at 22:16.
- The account plus payer test passed once (peak 958 MiB) before the final `deployments.js` sentence edit. It was rerun
  on the final source (above).
- The no-wallet test failed five times while I developed it:
  1. My `Created`-event log filter was wrong.
  2. Same failure as 1. This run started at 18206 MiB available, **below the 18 GiB start floor**. It ended as an
     ordinary test failure; I filtered its guard line out, so its minimum available memory was not recorded. Every
     later run was gated by the wrapper.
  3. No host is registered on the fork, so `deployOnChain` needs an explicit `maxRate6`.
  4. viem caches `getBlockNumber`.
  5. **The real gap**: "Failed to fetch" on readback, because the gateway had no CORS. This was fixed in the adapter as
     described above, and the next run passed.

## Activation dependencies (nothing activated)

1. **Adapter rollout.** Each storage adapter in a profile's plan must run the new component `132ba32f…` or a later
   reviewed build. Its operator sets:
   - `upload.walletAudience`: its full deployment id;
   - `upload.allowOrigins`: the dashboard origins;
   - `upload.contractWallets`: chainId 8453, at least 2 distinct https reader hosts they trust, quorum ≥ 2, and
     `3 × readers × timeout_secs` well under `max_age_secs`.

   Until then:
   - an account's Startup publish fails visibly ("adapter refused the upload (HTTP 401)"). It never falls back to a
     wallet or a token;
   - any browser publisher (v1 too) needs the gateway CORS, unless the fleet's TLS proxy already adds it in production.
     I could not verify that here; no SSH or production access.
2. **Profile storage plan.** The owner's `storage` plan must name those adapters (upload, audience, gateway), with
   `minimumCopies` ≥ 2.
3. **The account is deployed first.** The dashboard's account panel does this through its normal path (bundler or
   payer). Counterfactual accounts are refused by design.
4. **Site build.** The changed site files reach users through the normal site build (`scripts/build-site.mjs`; the
   bundle check passed). The management vendor bundle is held and was not rebuilt; it is not involved.
5. **Copy sync.** `src/contract_wallet.rs` must be re-copied, and its pinned hash test updated, whenever the shared
   `wallet.rs` `check_1271` changes. Those files are owned by the app-auth workers.
6. **Known limits** (documented):
   - v2 replay memory is per adapter process. A restart, or several instances behind one name, can accept a captured
     authorization again within its ≤ 900 s expiry, for the same body, route and deployment only, and it consumes
     quota. v1 has no replay memory at all.
   - Platform sessions still use the legacy validating routes.
