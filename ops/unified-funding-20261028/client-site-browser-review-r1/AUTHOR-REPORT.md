# client-site-browser-r1 — TEST browser qualification harness for the actual /funding page

**Status: source only. Nothing was run, built, bundled or browser-tested by its author.** Only Read, Grep and Write
were used. I wrote only `client-site-browser-r1/`. client-site-repair-r2, client-browser-migration-r1, r4, `source/`
and production are unchanged.

Nothing here is evidence that the page works until root builds and runs it. Production stays off:
- every production `FUNDING_*` value is untouched and null;
- no production URL, RPC, database or key is used;
- the real wallet outcome stays UNKNOWN and is never resent.

## What runs, and what is mocked

| Actual (unchanged bytes) | Mocked shell (TEST only) |
|---|---|
| **r2 page and helpers:** `client-site-repair-r2/authored/site/js/pages/funding.js`, `funding/flows.js` and `funding/state.js`. They are bundled byte-identically; only module **resolution** differs. The build refuses unless the bundle's inputs are exactly these pinned files. | `shell/facade/api.js`: the `Enclave` object (`address`, `chainId`, `provider`, `base`) and a TEST `WALLET_SESSION_KEY` (`client-site-browser-r1-TEST-wallet-session`, never `enclave_wallet_session`). |
| **`util.js`:** `source/site/js/core/util.js` (`$`, `esc`, `emit`, `on`, `showToast`, `lsGet`/`lsSet`). The page and the shell share this one module. | `shell/facade/wallet.js`: `connectWallet` refuses; there is no wallet. |
| **Generated client:** the portable funding client `client-site-repair-r2/candidate/site/vendor/funding.js` (327921 bytes, sha `4c56d071…`), served as-is at `/harness/vendor/funding.js` and hash-gated. Every core call is the actual one: `verifyRuntime`, `freshRecoveryScope`, `loadLegacyEvidence`, `buildMigrationPlan`, `signSteps`, `runMigration`, `reconcileMigration`, `quoteGasFund`, `confirmGasFund` (native P-256 session-key signature), `ownerControl` and `IndexedDbV2Store`. | `shell/facade/sessions.js`: `sdk()` is the actual SDK, except `IndexedDbStore()` opens this run's random TEST DB. `sessionsConfig()` is the site's own `new S.RelayClient(relayRoot()).config()`, plus a labelled "config unavailable" switch. `relayRoot()` is the site's expression over `Enclave.base`. `accountFromSession()` is a counted no-op. |
| **SDK:** the vendored SDK `source/sdk/sessions/dist/browser.mjs`, served as-is at `/harness/vendor/sessions.js` and hash-gated. | `shell/facade/config.js`: `FUNDING_RUNTIME` = the fixture's deployed-receipt pins; `FUNDING_MIGRATION_PROPOSAL` = the TEST 29 / 0.8 / 0.2 split over 8 + 2 apps for this run's original sid; `FUNDING_MIGRATION_APPROVAL` = null until the harness's explicit TEST approval; `APP_CATALOG_RPCS` = `<origin>/rpc` only. |
| **Backend:** the fixture from the root-qualified `client-browser-migration-r1/harness/server.mjs`: owned loopback Anvil (chain id 8453, osaka, `--slots-in-an-epoch 1`, no code-size override, native P-256 at 0x100 identity-checked, no shim), the ten-app rig, the actual composed relay with one TxQueue, the TEST fixture signer, the read-only `/rpc` allowlist, root's lost-reply fault (headers + truncated body) on the first `POST /v1/sessions/funding/open`, the loopback Host pin, CSP, and shutdown of the owned PID only. | `shell/facade/vendor-funding.js`: `export *` of the actual client, with two overrides. `IndexedDbV2Store()` opens the TEST DB. `jsonRpc()` is the actual one, preceded by a one-shot "RPC hold" used for the chain-switch test. |
| **Browser primitives:** real IndexedDB, non-extractable WebCrypto keys, and page reloads. | `shell/facade/empty.js`: the header, footer and toast components (no custom elements). `shell/harness-state.js`, `shell/main.mjs` and `page/index.html` form the harness panel. |

**Signing boundary:**
- Owner EIP-712 signatures come from the server's **TEST fixture signer** (public Anvil owner key, restricted
  server-side to the owned fixture's domains and types, at most 24 prompts).
- The page reaches it through an EIP-1193-shaped object (`eth_signTypedData_v4` only) that the shell sets as
  `Enclave.provider`. Nothing is injected into `window`, and no provider is discovered.
- This tests the page's and the core's typed-data construction, guards and prompt counts. It does not test a real
  wallet.

## Files

| File | Role |
|---|---|
| `generator/generate.py` | Derives `out/server.mjs` from the pinned prior server with 15 anchored, reversible edits. It refuses null or drift, an existing `out/`, any anchor not found exactly once, or `--code-size` / `pkill` / `killall` / process-group kills. |
| `generated/GENERATOR-PINS.json` | sha256 of `client-browser-migration-r1/harness/server.mjs`. **null; root fills it** with the root-fixed version it ran. |
| `build/build-harness.mjs` | Bundles `shell/main.mjs` with `esbuild` 0.28.1, resolved from `source/package.json` (actual dependency name, version checked). The resolution table is explicit and any unlisted import refuses. It builds in memory, checks the inputs equal the pinned set and that the externals are referenced, then writes `page/dist/harness.js`. |
| `generated/BUILD-PINS.json` | Build inputs. The r2 page, state and flows values are taken from root's r2 SOURCE-PINS; `funding.js` and the SDK use root's reported or r4 values. `util.js` and the shell/facade files are **null; root fills them**. |
| `generated/HARNESS-INPUTS.json` | The derived server's `OWN_INPUTS`. `index.html` and `dist/harness.js` are **null**; `funding.js` and the SDK are prefilled. Also holds the `vendor` route map. |
| `shell/main.mjs`, `shell/harness-state.js`, `shell/facade/*.js` | The shell and facades described above. |
| `page/index.html` | The harness panel (`#hstatus[data-result]`, `#hphase`, `#hdbs`, phase buttons, `#hstages`, `#htoasts`, `#hlog`) and the page mount (`#fdBody`). |

### Derived-server edits (everything else is byte for byte the prior server)

| Edit | What it changes |
|---|---|
| Provenance | A header comment, and the `HERE` comment. |
| Vendor routes | Two hash-gated static routes, `/harness/vendor/funding.js` and `/harness/vendor/sessions.js`. |
| `ALT_TIER = 3000` | A second pinned pool tier in the activation manifest and the runtime pins, so the page's tier input can change. The 3000 pool already exists in the rig; the relay checks its codehash and `adapter.poolFor(3000)` at startup. |
| Budgets | `MAX_PROMPTS` 12 → 24 (this harness plans 18) and `MAX_TICKS` 50 → 150. |
| Intake-off fault | `POST /test/fixture/intake {off}` makes `GET /v1/sessions/funding/config` answer the service's own error shape: `503 {error, code: "funding_disabled"}`. Every other `/funding/*` route, including `/funding/owner`, is still the real service. |
| Prefix | The TEST DB and temp-dir prefix becomes `client-site-browser-r1-`. |

## Phases

Each phase is **one click** on a harness button, enabled only in its phase. Nothing runs before **TEST Start**. Each
phase clicks the **page's own DOM buttons**, waits for its toast and re-render (bounded at 90 s), then checks the fixture
counters, the journal in real IndexedDB and the owned chain. Phases 1–11b start with one tick plus a remount (what an
`enclave:wallet` event does), so the page never pins a stale block.

| # | Click | The phase checks |
|---|---|---|
| — | **TEST Start** | <ul><li>Random DB names `client-site-browser-r1-TEST-{legacy,v2}-<16hex>` are recorded with the server; other names are refused.</li><li>The original 30 USDC session opens with the actual SDK: non-extractable key, pkcs8 export refused, explicit `["*"]` grant.</li><li>Owner down exactly 30; exactly 2 prompts so far.</li><li>Reloads.</li></ul> |
| 1 | Page **Check original & prepare plan** | <ul><li>Before: the page shows the proposed $29.00 / $0.80 / $0.20.</li><li>The journaled plan is exactly the TEST terms: order; same key; `oldBalance6` 30000000; split 29 + 1; nucbox 0.8 / 16 ops / 8 apps; metal 0.2 / 4 ops / 2 apps; no gas wildcard; the ten deployments; `hashOf(terms) == termsHash`, and the page displays that termsHash.</li><li>"Waiting for review"; Sign and Send disabled; $30.00 equals the original.</li><li>No prompt and no POST. Two non-extractable gas keys for this relay.</li></ul> |
| 2 | **TEST-approve** | <ul><li>Re-checks the TEST terms, stores a TEST approval for exactly that termsHash, then reloads.</li></ul> |
| 3 | Page **Sign next (4 steps)**, account switch on prompt 2 | <ul><li>The hold switches `Enclave.address` to a public non-owner while prompt 2 is open; the answer is discarded.</li><li>Exactly 2 prompts, no POST, all steps still planned; the page offers nothing to the other account.</li><li>After switching back, Send is disabled: nothing was held.</li></ul> |
| 4 | Page **Sign next** (7 prompts, in step order), then **Send signed steps** | <ul><li>Terminate and the replacement are proven.</li><li>The first gas open is `admitted` with no txHash; its reply was dropped by the fixture fault. Metal stays planned.</li><li>`funding/open` was hit once.</li><li>The TEST active pointer moved to the replacement.</li><li>The page shows "Outcome unknown" and offers only Check status.</li></ul> |
| — | **Reload page** | |
| 5 | Page **Check status on chain** | <ul><li>Loaded by a reload.</li><li>nucbox is proven from chain logs.</li><li>No signature and no resend; the page now offers Sign next (1 step).</li></ul> |
| 6 | Page **Sign** (2 prompts), then **Send** with a chain switch at the first chain read | <ul><li>The RPC hold switches `Enclave.chainId` to 1 before the send's first chain read. The core's admission (guarded CAS) is refused.</li><li>No prompt and no POST after that; metal stays planned and earlier proofs are kept.</li><li>The page says to switch to Base. Back on Base, the dropped bundle is not reused.</li></ul> |
| 7 | Page **Sign** (2 prompts), then **Send** | <ul><li>"Migration complete"; 15 prompts in total.</li><li>Sends: `/open` 2, `/owner` 1, `/funding/open` 2.</li><li>Conservation: the owner is down exactly 30 since Start; the legacy vault holds 29 and the successor 1.</li><li>Same key: the replacement passes the host's real `verifyApiRequest` (wildcard), and the original gets 401.</li><li>On chain: nucbox exactly 8 apps / 0.8 and metal exactly 2 apps / 0.2, `anyApp = false`.</li></ul> |
| 8 | Page **Get quote** ×3, plus input changes | For each of deployment (another nucbox deployment, same grant), amount (half) and tier (3000):<ul><li>After the act re-render the quote is still displayed: digest, deployment, wei, tier, fee, maximum, seconds left. The controls are restored to the quoted inputs, and Fund is enabled.</li><li>Changing that input clears the quote and disables Fund.</li><li>A **forced** click on the stale Fund button is refused (`quote_stale`) with no `/funding/execute`.</li></ul> |
| 9 | Page **Get quote** then **Fund** | <ul><li>"Funded:", not pending.</li><li>The journal `gas-execute` entry has the displayed digest, the selected deployment, the nucbox sid and status `settled`.</li><li>The debit is ≤ the maximum, and the grant balance and successor vault USDC each fell by exactly that debit.</li><li>Exactly one execute.</li></ul> |
| 10 | Intake off, then config/catalog unavailable; page **Terminate** on metal | <ul><li>Intake off: "New gas funding is paused", and Terminate stays enabled.</li><li>Config unavailable: migration and gas sections are unavailable, but the controls still list the grants with buttons enabled.</li><li>One Terminate prompt on the successor vault and one `/funding/owner`; `intakeOffReplies > 0`; metal is not live on chain.</li><li>Restores intake and config.</li></ul> |
| 11 / 11b | **Null runtime** (reloads), then check | <ul><li>The page shows "not set up" / "no deployed successor" / "Not available".</li><li>**No enabled button**; no prompt and no POST after 3 s.</li></ul> |
| — | **Delete this run's TEST databases** | <ul><li>Deletes only the two name-checked TEST DBs, the TEST localStorage key and sessionStorage.</li></ul> |

The final status is `#hstatus[data-result="PASS"]` with "ALL PHASES PASS (TEST fixture only)". Any failure shows
`FAIL: assertion failed: …` with the failing `li[data-result="FAIL"]`.

## Root run order (I have not run any of it)

1. Review everything, then fill `generated/GENERATOR-PINS.json` and run
   `python3 client-site-browser-r1/generator/generate.py` (source prep: 1536 MiB, floor 24576). Review `out/server.mjs`
   against the prior server. All edits are listed in `out/GENERATED.json` and above.
2. Fill `generated/BUILD-PINS.json` (`util.js`, the shell and facades). Then run
   `node client-site-browser-r1/build/build-harness.mjs` as a separate step of about 256 MiB. Review `page/dist/harness.js`.
3. Fill `generated/HARNESS-INPUTS.json` (`page/index.html`, `page/dist/harness.js`).
4. Under the shared queue guard (768 MiB test guard, 700 RSS, floor 27648, 1 CPU, no swap), run
   `node client-site-browser-r1/out/server.mjs 0 900`. It prints `TEST ONLY http://127.0.0.1:<port>/`; Ctrl-C or
   SIGTERM stops it and **only its own Anvil**, and removes its temp dir.
5. In a fresh browser profile, CUA clicks: TEST Start → 1 → 2 → 3 → 4 → Reload page → 5 → 6 → 7 → 8 → 9 → 10 → 11
   → 11b → Delete. It reads `#hstatus` after each click.

## Limitations

- **Nothing is run, built or measured.**
  - The generator anchors were copied from the prior server as I read it. If root's copy differs, the generator refuses;
    it never patches approximately.
  - Memory and CPU under the 768 MiB / 1 CPU guard are unmeasured; Chromium plus Anvil plus the relay may not fit.
- **Untested esbuild assumptions:**
  - esbuild should inline the page's `import("/vendor/funding.js")` (aliased to a bundled facade) and the shell's dynamic
    page import as lazy initialisers.
  - It should support `export *` from an external URL inside a non-entry module, with local exports taking precedence.
  - If not, the build or boot fails visibly.
- **The fixture differs from the qualified one in exactly these ways:** the second fee tier (3000), the prompt and tick
  budgets, the two vendor routes and the labelled intake-off fault. The 3000 tier is shown and selected but never quoted
  or executed. If the relay refuses the two-tier manifest at startup, the server fails before serving.
- **Signing is not a wallet.** There is no real wallet UX, rejection path, contract wallet or real chain switch prompt.
  "Account/chain switch" means the shell changing `Enclave` and emitting `enclave:wallet`, as `wallet.js` does on
  `accountsChanged` / `chainChanged`.
- **The holds are shell instrumentation.**
  - The sign hold switches context after the fixture answered prompt 2, so that prompt counts as answered and is
    discarded.
  - The RPC hold sits in the facade's `jsonRpc` wrapper; it delays nothing else and changes no arguments.
- **Timing:**
  - Phases rely on the page's toasts and DOM text, which are r2 strings; a wording change in the page would need matching
    harness text.
  - Each wait is 90 s at most, and the metal end-on-chain wait 60 s.
  - The pinned-block age is handled by one tick per phase start.
- **Not covered:**
  - multi-tab or cross-tab behaviour;
  - reorg, finality policy, void/re-arm on chain time;
  - a real HTTP 202 pending reply;
  - relay restart, withdraw, and the session-key End button. These are covered, if at all, only by root's Node and native
    tests.
- **TEST terms only.** The approval, the split, the 8 + 2 partition and the fee policy are TEST values. The TEST
  approval is created only by the explicit harness button after the plan checks above, and never outside this origin.
