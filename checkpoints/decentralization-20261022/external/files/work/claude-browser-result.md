# Browser independent mode (audit scope S1): result

**Work location and constraints.**
- Worktree: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`, branch `decentralize/nan-retirement`, base
  `af16a74c`.
- Nothing was committed or pushed.
- There were no live services, chain or wallet transactions, SSH sessions or private configuration. All chain
  activity ran on a local anvil.
- Other workstreams were editing the same checkout concurrently (CLI, Windows, isolation, `network/` management
  routes, `sdk/bootstrap/package.mjs` owner names). I did not touch their files; see "Compatibility" for the one
  interaction.

## What a user can now do without `api.enclave.host` or the upload-token API

**Profile.** Import a network profile on the dashboard, check it against the chain, and confirm it.

**Publish.**
- Publish a component through the real publish form.
- The browser computes the CID locally and signs once per storage adapter.
- An upload counts only if each adapter answered the local CID and every byte read back matches.
- It needs `minimumCopies` verified copies, then the wallet's own catalog transaction.

**Deploy and fund.**
- The spend ceiling is the cheapest live host's price in the pinned registry, read at an agreed block.
- Funding uses EIP-3009 against the profile's token, whose domain is read from the chain.
- No claim hint is sent.

**Observe.**
- Rows come from the ledger at a block the profile's RPCs agree on. A live lease reads **claimed**, with the host
  named from the registry.
- A disagreeing or failed read shows as a failed read, never an empty list.

**Manage.** Top up, Version, Resources, Config, Protect, Suspend/Resume, Cancel and Transfer stay chain-direct.

**Owner-committed startup** (new **Startup** tab, and an option in the deploy dialog to create the record with
startup disabled).
- The package and activation envelope are byte-identical to the CLI's `bootstrap prepare/publish/activate` and
  `deploy --prepare-only`.
- The package is published to the storage plan and read back, the record is re-read at an agreed block, then the
  owner commits with `setConfig`.

**Owner network setting.**
- Signed by the wallet and posted straight to the profile's public directories.
- The nonce is set above every nonce the directories report.

**Wallet sessions on the pinned `SessionVaultFactory`.**
- Uses the SDK's `prepareSessionOpen`, `prepareCall` and `prepareTermination`.
- The connected wallet submits each call and pays its gas.
- The vault address is checked against an agreed read before submission.

**Legacy hosted mode is unchanged when no profile exists.** The existing site tests and the hosted e2e suite pass.

## Design decisions worth reviewing

- **Profile format (`enclave-browser-profile` v1, `site/js/core/independent.js`).**
  - `contractPins` is exactly the CLI's `--contract-pins` document.
  - `storage` is exactly the CLI/host storage plan.
  - Also: `rpcs` (2–8 distinct origins; HTTPS, or HTTP only on loopback), `quorum` (≥2), `confirmations`,
    `maxBlockAgeSeconds`, `usdc` and optional `directories`. No unknown or duplicate keys; at most 32 KiB.
  - Documented in `docs/network/independent-dashboard.md`.
- **No silent fallback.**
  - An invalid saved profile, or one not yet confirmed in this tab, pins no contract and no RPC, so nothing can be
    signed. It never falls back to the hosted defaults.
  - In independent mode `Enclave.base` is the scheme `independent-mode:`. Any stray `fetch(Enclave.base + …)`
    fails locally without network access, and every API method refuses with one plain message.
- **Per-tab confirmation of saved profiles.**
  - `site/js/core/config.js` already refused `localStorage` RPC/book overrides off loopback, because a planted
    value outlives the exploit that wrote it. A saved profile is that kind of value: it decides which contracts the
    wallet signs for.
  - So each tab shows the profile's name, fingerprint and pins, and waits for a click before using it.
  - A profile built into a mirror's code (`BUILT_IN_PROFILE_TEXT`) needs no confirmation.
- **The address book is never consulted in independent mode.** `ADDRESS_BOOK_ADDRESS` is "",
  `__applyAddresses` is a no-op, and `addressbook.js` skips resolution. Optional features that only the book
  configures (featured slots, reviews, order router, v1 secret vault) are off.
- **Agreeing reads (`site/js/core/quorum.js`).**
  - The reader takes the quorum-th highest head minus the confirmations, and requires `quorum` matching block
    hashes and timestamps.
  - Each call is made at that block hash (EIP-1898) and needs `quorum` identical results; agreed reverts are
    reported as reverts.
  - It refuses blocks that are stale, in the future, or older than one already used.
  - Used for decisions: listing and ownership, prices that become the spend ceiling, the token domain, re-reads
    before a startup commit, and the session vault address.
  - Plain display reads keep the rotating pool, restricted to the profile's RPCs.
- **Vendored SDK.** `site/vendor/sessions.js` was stale: it lacked `prepareSessionOpen`. I replaced it with an exact
  copy of `sdk/sessions/dist/browser.mjs`, which is what `scripts/build-vendor.mjs` does. I confirmed `dist`
  equals a fresh esbuild of `sdk/sessions/src`. `sdk/sessions` itself was not edited.
- **Browser re-implementations instead of Node-only SDK modules.** `sdk/storage/*` and `sdk/bootstrap/*` use
  `node:crypto` and `Buffer`, so the browser has its own UnixFS importer, storage-plan publisher and startup
  package module. Tests prove byte equality with the SDK and CLI implementations.

## Files

**New:**
- `site/js/core/independent.js`: profile format, validation, state and confirmation.
- `site/js/core/quorum.js`: agreeing fixed-block reads.
- `site/js/core/independent-chain.js`: ledger listing, registry prices and hosts, token domain, agreed vault read.
- `site/js/core/unixfs.js`: CID importer, WebCrypto version of `sdk/storage/unixfs.mjs`.
- `site/js/core/storage-plan.js`: wallet-direct multi-adapter publication with exact-byte readback.
- `site/js/core/startup-package.js`: owner-committed startup package, envelope and readback; accepts and preserves
  committed names.
- `site/js/core/independent-ui.js`: settings panel (import, check, confirm, summary, stop using).
- `docs/network/independent-dashboard.md`.
- `test/site-independent-{profile,quorum,storage,network,bundle,browser}.test.mjs`.
- `test/helpers/independent-browser-rig.mjs`.

**Modified:**
- `site/js/core/config.js`, `addressbook.js`, `api.js`, `chain.js`, `catalog.js`, `fund.js` (shared
  `fundingTerms()`), `sessions.js`, `enclave-network.js`.
- `site/js/pages/deploy.js`, `dashboard.js`, `apps.js`.
- `site/components/deployments/deployments.js`:
  - `claimHint` helper, which is a no-op in independent mode;
  - API-only tabs hidden;
  - Startup tab;
  - independent-aware WAF and config gates;
  - no GitHub mobile-index fetch in independent mode.
- `site/vendor/sessions.js` (synced as described above).
- `test/models-read-only.test.mjs`: its fixture was missing `hostsTakeConfig`. Five tests already failed at HEAD
  (I reproduced this against HEAD's component); they now pass.

## Tests run (all local; logs saved next to this report)

- **New tests (`claude-browser-tests.log`): 38/38 pass.** Covers the six `site-independent-*` files plus
  `test/models-read-only.test.mjs`:
  - **Profile:** strict validation; config bindings when on, unconfirmed, invalid and off; planted overrides
    ignored; the book cannot rebind; API calls refused with zero network access.
  - **Quorum:** a liar outvoted; a two-way split refused; down or wrong-chain endpoints; one endpoint racing ahead;
    stale, future and backward blocks; reverts.
  - **Storage:**
    - the browser CID equals the CLI's at chunk and 174/175 tree boundaries;
    - two of three verified copies succeed; corrupted readback or a wrong CID fails at one of two;
    - a declined signature uploads nothing anywhere;
    - startup packages, including custody and names, are byte-identical to the CLI's and verify with its verifier;
    - the activation envelope equals the CLI's transformation.
  - **Network:** the real `PublicDirectory` server accepts an owner-signed setting with one directory down, and
    refuses stale or stranger-signed settings.
  - **Bundle:** esbuild bundles `site/js/boot.js` as `build-site.mjs` does, the independent modules are in the
    graph, and no Node-only SDK module is pulled in. The vendored SDK equals `dist` and exports the relay-free
    functions.
  - **Browser** (Chromium, unbundled site): anvil (chain 8453) with the Foundry-built ledger at schema 16, the
    registry, catalog, payment router and pinned factory; three RPC proxies; three HTTPS adapters that verify the
    wallet signature as the real adapter does; a real directory; every `*.enclave.host` and upload-token request
    refused. Steps covered:
    - profile import, check and per-tab confirmation;
    - real publish form with one adapter refusing (2 of 3 copies);
    - deploy and fund (ceiling = registry price); an independent host claims; the list and dashboard show it;
    - a liar outvoted, and a split shows "failed read, not an empty list";
    - Startup tab commit, verified on chain and in adapter bytes;
    - a prepare-only record, and refusal to fund one;
    - network setting published to the directory;
    - a session opened, a vault-owned deployment created through it, the session ended with its unspent budget
      returned.
    - After activation the browser contacted only the local rig's origins: zero Enclave or third-party hosts.
- **Existing site tests (`claude-browser-regression.log`): 323/323 pass.** These are the 28 test files that import
  any module I changed.
- **Hosted e2e Playwright suite (`claude-browser-e2e-hosted.log`): 10/10 pass.** Passkey, SIWE session, device
  flow, credit vault, orders, sessions and catalog.

## Compatibility with the concurrent owner-names workstream

`sdk/bootstrap/package.mjs` (theirs, uncommitted) adds an optional `names` field, appended last. Without handling
it, the browser would have rejected a committed package that had names, and a browser re-commit would have
silently dropped the owner's custom domains.

The browser now:
- accepts the field, with a mirror of `validateNames`;
- shows any committed names;
- carries them over unchanged when the owner publishes new settings;
- never invents or edits them.

A test pins byte equality and agreement on refusals against the SDK's current `validateNames`. It skips if the SDK
lacks that function. **If that schema changes, update `site/js/core/startup-package.js`.**

## Mapping needed from Codex's `contracts/deployments/network-profile-base.json`

I did not assume its shape. To produce a browser profile from it, the reviewed file must supply the following.
The rest is a plain field mapping, as long as these names are explicit in that file.

| Browser field | Source in the reviewed file |
| --- | --- |
| `contractPins` | The CLI pin document: version 1, chainId 8453; `registry`, `deployments` (the **live** ledger, not the site's baked fallback), `appCatalog`, `proofOfTime`, `enclavePay`, `verificationFees`, `sessionVaultFactory` (`0xEc9277a3…` pinned factory, or zero), `secretVaultV2` |
| `rpcs`, `quorum`, `confirmations` | At least 2 HTTPS RPC origins and the agreement policy |
| `usdc` | Base USDC `0x8335…2913` |
| `storage` (optional) | A storage plan with adapter deployment IDs as audiences, if browser uploads are wanted |
| `directories` (optional) | HTTPS directory origins, if browser network settings are wanted |

**HTTPS requirement.** The current public directories are documented as `http://IP:8188`. A browser on an HTTPS
origin cannot reach them because of mixed content. The Network tab needs HTTPS directory origins.

## Residual gaps

1. **Not deployed.** Nothing is published. Activation needs:
   - a reviewed profile (above);
   - a site build. Either ship the profile as `BUILT_IN_PROFILE_TEXT` in an operator mirror, or let users import
     it;
   - HTTPS storage adapters whose `upload.walletAudience` matches the profile, with `allowOrigins` covering the
     dashboard origin. The adapter's default CORS allows only `https://enclave.host`.
2. **Hosted features stay off in independent mode:**
   - card and credit payments, and passkey accounts;
   - relay-held secrets (custody v2 is another workstream);
   - logs, restart and in-browser Verify (they ride the API tunnel; a management plane is another workstream);
   - custom domains (owner names are another workstream);
   - host pinning and live capacity views;
   - ETH funding (no oracle read yet);
   - session top-up and owner Promote (they use the relayer);
   - bring-your-own WireGuard;
   - paid-provider authorization (the pin document has no `connectivity` key);
   - phone downloads.
3. **Browser access to apps** still uses `*.app.enclave.host` names, which depend on Enclave's zone. The front still
   certifies only that zone unless the owner-names work lands. Fully independent access remains the native client.
4. **Trust limits.**
   - RPC agreement is not a light client.
   - The wallet's own provider estimates gas and broadcasts.
   - The header balance falls back to `mainnet.base.org` (`site/js/core/wallet.js`, not my file).
   - Config edits cannot be checked against host capabilities in this mode.
   - Pinned contracts keep their governance (catalog `transferApp`, ledger owner powers) until sealed.
   - A verified copy proves current availability only.
   - No production profile, adapters, directories or RPCs used here are independently operated.
5. **Sessions.** Vault-owned rows use session intents submitted by the wallet. A production-environment
   version/config change on a vault row needs the owner's Promote, which is relayer-only, so the vault refuses it
   in this mode.
6. **The quick-deploy dialog** has no host target picker in independent mode (that table comes from the API). The
   ceiling is the cheapest live registered host, and any eligible host may claim.

## Next safe tasks

- **(a) Read-only ETH funding:** read the ledger's ETH/USD feed at an agreed block.
- **(b) Profile publication:** add a `scripts/network/browser-profile.mjs` that turns the reviewed
  `network-profile-base.json` plus an operator storage plan and HTTPS directories into a browser profile, and
  prints its fingerprint for announcement.
- **(c) Session ownerOperations without the relay:** owner-signed vault calls submitted by the wallet. Needs an SDK
  `prepareOwnerOperation`, which is SDK work (not mine).
- **(d) Profile-aware native-client launcher in the dashboard:** link from a claimed row to native client
  instructions with the full ID and profile pins.
- **(e) After the owner-names and management-plane workstreams land,** add their browser panels behind the same
  independent-mode gate.
