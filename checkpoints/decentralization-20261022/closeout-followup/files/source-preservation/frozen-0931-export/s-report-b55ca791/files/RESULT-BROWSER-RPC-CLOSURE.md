# Browser RPC consumer closure (RESULT-BROWSER-RPC-CLOSURE, S, 2026-10-23)

**Status: SOURCE + TESTED CANDIDATE. Not deployed, not integrated into main, no production change.**
- **Not done:** no SSH, no production write, no wallet request, no signing with a real wallet, no funding, no new
  contract, no VM change, no toolchain install, no push.
- **Unchanged:** every vendored bundle.
- **This is not RPC independence.** With hosted mode (the default), the site still reads through public RPCs. A
  confirmed independent profile is only as independent as the endpoints it names, and **no production self-hosted,
  browser-reachable endpoint exists** (§7).

## 1. Immutable commits (`work/browser-rpc-closure/repo`, branch `browser-rpc-closure`, SteveDeFacto)

| commit | what |
|---|---|
| `e820e2405af91010c18913acf4740f651618c644` | base, from `rpc-priority/repo` git objects (A's working tree not copied) |
| `2bd1eea0cdf70dc33b69b71b6decc7c2b0186266` | **root's WalletConnect fix, integrated unchanged.** Its diff is byte-identical to root-wallet-rpc-fix `ed071dc..320d7e9` (format-patch sha256 `eb539a1c…`; author and date preserved; provenance in the message) |
| `349318a0600917bad8f391ad628fa0c7f134b3f6` | this closure: 12 source files, the dashboard doc, 2 new tests + 1 helper, 1 test-reset fix |

The source is read with `git show 349318a:<path>`. Commit scan: §6.

**Report artifacts** (this file, the endpoint note, `jobs/`, `logs/`) are committed separately, in the report-only
repository `work/browser-rpc-closure` (it ignores `repo/` and the scratch worktrees), as SteveDeFacto. Its HEAD is the
report commit.

## 2. What a confirmed independent profile now guarantees in the page

The audit covered `config`, `independent`, `chain`, `addressbook`, `platform-addresses`, `independent-chain`, `quorum`,
`wallet`, `fund`, `pay`, `sessions`, `custody`, the grant page, the admin console, and the lazily loaded SDKs:
- **sessions SDK:** its own `chainClient` defaults to `base-rpc.publicnode.com`;
- **custody bundle:** viem clients;
- **WalletConnect:** `rpcMap`;
- **management, host-policy, host-capacity bundles:** document fetches only, chain through the page's quorum reader;
- **AA:** the owner's own bundlers.

**Already correct at e820, kept:**
- `baseRpc` rotates over the profile's RPCs and refuses when there are none.
- The quorum readers (`independent-chain`, `platform-addresses`) use every RPC with the profile's quorum, confirmations
  and block age.
- Independent sessions read through the quorum client.
- The address book resolves through quorum reads.
- An invalid or unconfirmed profile pins no contract.

**Fixed (each was a real path at e820; the control in §4 shows it):**

| path | e820 | now |
|---|---|---|
| `wallet.usdcBalanceOf` / `ethBalanceOf` | asked the **wallet's provider first** (its own RPC), even for an invalid or unconfirmed profile | profile RPCs only, in independent mode |
| `wallet.sendTx` gas estimate (no caller limit) | wallet's provider first | profile RPCs only. With every route down: *"none of the network profile's RPC endpoints could check this transaction - nothing was sent"* (previously reported as "would revert") |
| `fund.payerHasCode` (picks the funding path) | wallet's provider first, then a guess ("EOA") when all fail | profile RPCs only; failure surfaces |
| `pay.tokenNonce` / `routerAllowance` | wallet's provider first | profile RPCs only (in independent mode) |
| `custody` vault reads | first **3** RPCs, agreement **2**, no confirmations or age limit | **every** RPC, the profile's quorum, confirmations and `maxBlockAgeSeconds` |
| grant page (`/grant`, independent) | `chainClient(rpcs[0])`: one origin, no failover, no agreement | the profile's quorum session client |
| `waitReceipt` | a refused or all-down profile looked like "timed out" | refusal rethrown; an all-down outage is named |
| **profile changed in another tab** | the old tab kept reading and **signing** on the old routes until a manual reload | every chain read (`baseRpc`, quorum readers, custody, receipts) and every transaction (`assertPlatformTransactionCurrent`, the gate all 7 send paths call) refuse until reload. Sign-out refuses and keeps its key |
| session record opened under a profile | a hosted page served it through the **RPC stored in the record** (`Session.chain()` falls back to `handle.rpc`) | not served by a hosted page (it stays stored and serves again under the profile); independent records store no RPC |
| admin `migrator.gasFor` | `fetch(APP_CATALOG_RPCS[0])`, a relative URL when none was selected | no request without a selected RPC |

**Hosted mode (no profile) is unchanged.** It reads through the wallet first, then the public pool
`base-rpc.publicnode.com`, `base.drpc.org`, `1rpc.io/base` and `mainnet.base.org`.
- WalletConnect's `rpcMap` is `mainnet.base.org`, and the hosted `fallbackRead` also uses `mainnet.base.org`.
- The sessions SDK defaults to `base-rpc.publicnode.com` unless the relay names an RPC.
- `startup-package.js` lists polkachu/tenderly only as documented log-history candidates; that list is unchanged.

These public defaults **remain until a cutover** to a production self-hosted service. They are disclosed in
`docs/network/independent-dashboard.md` ("Hosted mode").

**Preserved:**
- profile validation and fingerprint confirmation;
- administrator-directed book migration, with retired-target refusal;
- factory compatibility, existing sessions and the session nonce;
- owner termination;
- MetaMask, injected-wallet and SessionVault paths;
- every admin-console power.

No crypto was changed, and no new authority schema was added.

## 3. Signing and the wallet's own RPC (the hand-off)

- **Signing stays in the wallet.** Personal and EIP-712 signatures and `eth_sendTransaction` are wallet requests. No key
  is extracted and `eth_sign` is never requested.
- **Broadcast uses the wallet's RPC.** A transaction the wallet broadcasts goes through the RPC **the wallet** has set
  for Base. The page can neither see nor change it.
- **The popover says so (independent mode).** It adds a *Broadcast* row: "your wallet's own RPC". Its *routes* toggle
  lists the profile's RPCs. On an explicit click, *Offer them to the wallet* sends EIP-3085 `wallet_addEthereumChain`
  for Base with the profile's HTTPS RPCs (at most 3).
- **The wallet decides.** Most keep their own RPC for a network they already know, and the page says that.
- **Never silent.** Nothing switches networks silently. With no HTTPS RPC, nothing is offered, and the popover says
  wallets accept only HTTPS.
- **Drop check.** `waitReceipt` still asks the **submitting** wallet `eth_getTransactionByHash` after about 40 s. It
  only uses this to tell a dropped transaction from a slow one; receipts come from the profile.
- **WalletConnect.** It stays off in independent mode (empty project id). Root's fix makes its initializer refuse an
  invalid, unconfirmed or RPC-less profile, and otherwise use `rpcs[0]`. WalletConnect's `rpcMap` takes one URL, so
  there is no failover inside the SDK. With this commit the page never reads through the wallet provider in
  independent mode.
- **L1 forced inclusion** is E's scope and was not touched.

## 4. Tests (all through the shared queue, unchanged 16 GiB floor; logs in `work/browser-rpc-closure/logs/`)

The sha256 values of every tested source file, printed in each log, equal `349318a` (checked file by file).

| run | lane | result |
|---|---|---|
| `t1` **site-browser-rpc-closure** (new) | 256, peak 195 MiB | **10/10 pass** |
| `wc1` root's WalletConnect leaf checks, run directly with `--experimental-vm-modules` | 256 | **6/6 pass**. The wrapper also passes in `u1` |
| `br1` **site-browser-rpc-routes** (new, Chromium) | 1536, peak 813 MiB | **1/1 pass** |
| `u1`+`u2` 34 affected unit files | 512 / 256 | all pass except the 9 baseline failures (`b1`); see below |
| `br2` existing Chromium rigs | 1536, peak 1109 MiB | `site-existing-contract-sessions` **2/2 pass** (fixed profile **and** admin-controlled book: migration, recovery, sessions); `site-independent-browser` 5 pass / 13 fail, **identical to the e820 baseline `bb1`** |
| `forge1` Foundry subset (the 8 sources the rig deploys) | 512, peak 200 MiB | built; artifact sha256 values in the log |

**What `t1` covers.** It runs the real module graph, one process per profile state, with:
- a fake Base chain behind `https://rpc{0..3}.operator.example`;
- an inert wallet that answers differently from the chain;
- a fetch that refuses every other origin.

Scenarios:
- **confirmed:** only profile origins; the wallet sees only `eth_sendTransaction`; balance 42 (the chain's, not the
  wallet's 7); gas `0x668a` (the profile's `0x5208` + 25%); receipt; quorum over all 3; a stored session read through
  the profile, not its stored RPC.
- **one down:** rotation past `rpc0`; quorum 2 of 3.
- **all down:** every read errors by name; nothing reaches the wallet; refused = [].
- **invalid / unconfirmed:** no origin and no wallet call at all.
- **changed in another tab:** everything refuses with the reload message; sign-out keeps `sid1`.
- **hosted:** wallet-first reads, `eth_estimateGas` + `eth_sendTransaction` to the wallet; the 4 public pool origins
  (refused here); an independent session is not served.
- **hosted with a profile saved elsewhere:** sending refused.
- **custody:** a book-resolved vault read through all 3 RPCs; with 4 RPCs / quorum 3 and `rpc0` down, the 4th route is
  used; with 2 of 4 down, *"only 2 of 4 RPCs answered (need 3)"*.

**CONTROL:** the same scenarios on `git archive e820e2405 site network` fail all **8** checks:
- balance via the wallet;
- gas via the wallet;
- the wallet asked for a balance under an invalid profile;
- kept reading after a profile change;
- still sent after a profile change;
- a hosted page served a session through its stored RPC;
- custody used only 3 routes;
- custody agreement 2 regardless of quorum.

**What `br1` covers.** Chromium runs the unbundled dashboard on the rig: anvil, three CORS proxies as profile RPCs, the
wallet proxying to the anvil port, and every non-loopback origin refused.
- **The popover:** the balance comes through the profile; the route disclosure names all 3 RPCs and the "HTTPS only"
  note; no offer button appears for loopback HTTP.
- **One proxy down:** a balance, an agreed snapshot (2 RPCs), and a **real** `approve` broadcast by the wallet with its
  receipt read through the profile.
- **All down:** a named refusal; nothing more reaches the wallet.
- **Profile replaced in a second tab:** the first tab's read and send both refuse.
- **The wallet's RPC** received exactly `["eth_sendTransaction"]` over the whole run.
- **No forbidden origin** was attempted.

**Baselines (pristine e820 worktree, same `node_modules` and Foundry build):**
- `b1`: `deployment-move` fails 8 dashboard Pin/placement tests, and `site-independent-management-unit` fails the
  vendored-manifest **commit metadata** check (`commit` fields differ in this clone's history; the sha256 values match).
  `u1`'s failures, minus the two management parent tests, equal `b1` exactly.
- **The two management tests in `u1`** failed only because the test's `reset()` wiped all of `localStorage`, including
  the profile, which the new guard rightly reads as a profile change. The reset now keeps the profile key, with no
  assertion changed. In `u2`, 27/28 pass; the remaining failure is the baseline one.
- `bb1`: `site-independent-browser` fails the same 13 steps on e820. Step 5 ("a funded deployment owned by the wallet
  exists") fails and the later steps cascade from it. Step 20 fails on *"unexpected origin host.independent.test"*.
  This is pre-existing and unrelated to RPC routing; it was not chased here.

**Not run (reasons):**
- `site-platform-book-safe-recovery`, `site-independent-passkey-ui` and `site-independent-account-*` (Chromium): they
  need an anvil **fork of Base** (public upstream reads) or other artifacts.
- `site-independent-live-reads`: public network.
- The book-migration and session paths are covered by `site-existing-contract-sessions` (2/2), `site-addressbook-reader`,
  `site-platform-ledger-recovery`, `site-independent-account-sessions` and `site-session-auth` (all in `u1`, all pass).

**UI test limitation:** the popover was exercised in Chromium with an injected test wallet, not with MetaMask, Rabby
or WalletConnect. What a real wallet does with the EIP-3085 offer is its own behaviour and is not tested.

## 5. Source vs bundle closure

- **Vendored bundles:** none of the 6 manifests names a changed file. `custody.js`, `sessions.js` and `walletconnect.js`
  are unchanged, so **no vendor was rebuilt**.
- **The site bundle** (`site/dist`, gitignored) is generated at deploy by `scripts/build-site.mjs` (esbuild 0.28.1 and
  Tailwind from the root lock `package-lock.json` sha256 `9ada1611…`, entries bundled with code splitting, vendor
  copied). Its footer stamp carries the commit and date, so `dist` is not byte-stable across days.
- **`sb1`:** builds `dist` from `349318a` in its own worktree. It checks that the closure strings are in the bundle and
  which RPC hosts the bundle names. Result: §5a.
- **`site-independent-bundle`** (in `u1`, passes) bundles the independent paths exactly as `build-site.mjs` does.

### 5a. Bundle build result (`sb1` 512 lane, peak 420 MiB; `sb2` 256)

`scripts/build-site.mjs` was run on `349318a` in the scratch worktree `bundle-349318a`. It produced `dist/` with 236
files (28.5 MB) and no built-in profile.

**The closure is in the bundle:** "network profile changed in another tab" (3 files), "broadcast by your wallet" (2),
"none of the network profile's RPC endpoints could check this transaction" (2), "none of the network profile's RPC
endpoints answered" (2), and root's "Confirm a valid independent profile before connecting WalletConnect" (2). The
digest of the sorted per-file sha256 list of the `dist/js/*.js` files is `1fd5ddf8…`. It is stamped (date), so it is not
a release pin.

**RPC hosts the page bundle names:**
- `mainnet.base.org`, `base-rpc.publicnode.com`, `base.drpc.org` and `1rpc.io/base`: the hosted defaults of §2;
- `base-rpc.polkachu.com` and `gateway.tenderly.co/public/base`: `startup-package.js` `HISTORY_PUBLIC_OPTIONS`, history
  sources *offered* to an owner for the app guest, never selected and never read by the page.

The copied `vendor/` holds only the sessions SDK default `base-rpc.publicnode.com` (and its Sepolia twin), which is
reached only in hosted mode. All 10 vendored files in `dist/vendor/` are byte-identical to the committed ones.

**The build also rewrote two tracked generated files** in its worktree: `site/css/site.css` (Tailwind output) and
`site/js/gen/contract-artifacts.js` (2 bytecode metadata tails). None of their inputs changed in this diff
(`git diff e820e2405 349318a -- contracts site/css scripts package*.json` is empty). This is the build pipeline's own
regeneration, recorded for root, and not part of this candidate. Nothing in `repo/` was touched by it.

## 6. Commit scan

`python3 .githooks/scan-crypto-keys.py --range e820e2405..HEAD` (in `sb1`) covered `2bd1eea` and `349318a` and passed
(rc 0). The test keys are generated or anvil-public, and no real wallet key appears.

## 7. Remaining gates (not closed here)

1. **Public endpoints.** Hosted mode stays on public RPCs until a production self-hosted, browser-reachable RPC service
   exists and a profile (or built-in profile) names it. The exact HTTPS/CORS/method/discovery requirements are in
   `NOTE-BROWSER-RPC-ENDPOINT-REQUIREMENTS.md`. Copies went to F (`host-service-rpc-closure/NOTE-FROM-S-BROWSER-RPC.md`)
   and B (`rpc-runtime-final-integration/NOTE-FROM-S-BROWSER-RPC.md`).
   - B's runtime is 127.0.0.1-only and is not such an endpoint.
   - F's quorum roles need their own consumer composition.
   - Two names in front of one verifier are not a quorum.
2. **Trust level.** Profile answers are **agreement of configured RPCs**, not verified witnesses, and nothing here
   labels them proof-verified.
3. **Wallet broadcast.** It stays on the wallet's own RPC. The user can change it; the page can only offer
   (EIP-3085). Real-wallet behaviour is untested.
4. **Activation (root):** integrate `349318a`, choose when hosted defaults change, and run the deploy-time bundle build.
5. **Pre-existing failures** (`deployment-move` Pin tests, management manifest metadata, `site-independent-browser` step
   5 and `host.independent.test` origin) belong to their owners.

## 8. For D (preservation)

Preserve:
- `work/browser-rpc-closure/repo` branch `browser-rpc-closure` at `349318a`, with parent `2bd1eea` (root's fix) on
  `e820e240`;
- this RESULT, the note, `jobs/` and `logs/`.

The worktrees `baseline-e820` and `bundle-349318a` are scratch and can be dropped. The copied `node_modules` are
lock-identical to main's.
