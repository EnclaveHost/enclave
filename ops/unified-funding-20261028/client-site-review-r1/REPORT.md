# client-site-integration-r1 — REPORT

Status: **SOURCE ONLY, UNREVIEWED, NOTHING RUN.** I used only Read, Grep and Write, and wrote only inside this directory.
I did not run the generator, tests, esbuild, the site build or a browser. I did not sign anything, use the network, or
touch a wallet. I read the previous stages and the `source/` checkout but altered neither, and I touched nothing in
production. `run.py` and `TASK.txt` belong to root; I did not change them.

Nothing here claims that production, native or browser behaviour works. The pure-state tests and the source-text tests are
offline and have never been run. They cannot show that the page works in a browser, that a wallet signs, or that a
migration succeeds. All terms are **TEST terms and not approved**. The old $30 session has not been touched. The first
owner deployment request is UNKNOWN or expired, and nothing here builds a signable activation.

## 1. Exact files (this directory)

| File | Role |
|---|---|
| `authored/site/js/funding/state.js` | Pure state helpers with no imports, DOM, storage or network: scoping, proposal validation, money rows, approval matching, step views, the active-pointer decision, controls availability, the quote view and bound in-memory holding. |
| `authored/site/js/pages/funding.js` | The `/funding` page. It lazily imports `/vendor/funding.js`, the same pattern `core/sessions.js` uses for `/vendor/sessions.js`. |
| `authored/scripts/build-funding-vendor.mjs` | Bundles `sdk/funding/browser-entry.mjs` to `site/vendor/funding.js` with the existing esbuild. It refuses manifest drift, unlisted modules, non-package inputs and missing exports. |
| `generator/generate.py` | A narrow generator. It reads only pinned inputs and writes only `candidate/`. |
| `generated/SOURCE-PINS.json` | Input pin manifest (15 inputs). Root fills or confirms each value; the generator refuses any null. |
| `test/state.test.mjs` | 14 offline tests of `state.js`. |
| `test/page-source.test.mjs` | 7 source-text tests of the page, the build script and the generator. |
| `package.json` | `"type":"module"`, used only so `node --test` can import the `.js` files. It is not deployed. |
| `REPORT.md` | This file. |

## 2. What the generator produces (`candidate/`, which mirrors the source repository root)

| Target | Kind |
|---|---|
| `sdk/funding/{util,v2-store,chain-proof,funding-client,migration,browser-entry,funding-codec}.mjs` | The r4 core plus the client-r1 codec, **byte-identical except import specifiers** (see below). |
| `sdk/funding/MANIFEST.json` | Source hash and output hash for every core file. |
| `scripts/build-funding-vendor.mjs`, `site/js/pages/funding.js`, `site/js/funding/state.js` | New authored files, copied verbatim. |
| `site/funding.html` | New. Derived from `site/sessions.html` by 7 exact anchored replacements (title, description, h1, section `data-view="funding"`, heading, intro, `#fdBody`). |
| `site/js/boot.js` | Patched copy: one `funding:` PAGES line added after the `sessions:` line. |
| `site/js/core/config.js` | Patched copy: `FUNDING_RUNTIME`, `FUNDING_MIGRATION_PROPOSAL` and `FUNDING_MIGRATION_APPROVAL` appended, **all `= null`**. |
| `scripts/build-site.mjs` | Patched copy: `funding: "funding.html"` added to `PAGE_HTML` (for modulepreloads), and `"funding.html"` added to the explicit HTML copy list. Without this, `funding.html` would never reach `dist/`. |
| `site/_redirects` | Patched copy: a comment and `/funding    /funding.html    200` added after the `/grant` line. |
| `INSTALL-MANIFEST.json` | Every output with its target, kind and sha256. Patched files also carry `replaces_sha256`, the pinned source hash. |

**Generator refusals:**
- Inputs:
  - the pin set differs from the expected set;
  - any pin is null or has the wrong format;
  - any input's sha256 differs from its pin;
  - `candidate/` already exists.
- Core files:
  - a specifier rewrite does not occur exactly the expected number of times;
  - the target text already exists;
  - the reverse rewrite does not reproduce the original bytes;
  - a `../` or absolute import specifier remains.
- Site patches:
  - an anchor does not occur exactly once;
  - a replacement does not contain its anchor;
  - a patched copy does not reverse exactly to its pinned source;
  - a source already mentions the funding page;
  - config already defines a `FUNDING_*` export.

The specifier rewrites are:
- `"../../../source/node_modules/viem/_esm/index.js"` → `"viem"` (r4 files) and `"../../source/node_modules/viem/_esm/index.js"` → `"viem"` (codec);
- `"../../client-r1/funding-codec.mjs"` → `"./funding-codec.mjs"`.

`browser-entry.mjs` is copied unchanged. The generator has exactly two write sites, both under `candidate/`.

**Not changed:** the original sessions SDK (`sdk/sessions`), `site/vendor/sessions.js`, `site/js/core/sessions.js`,
`/sessions` and `/grant`, the owner controls there, the factory and book pointers, the relay and the contracts. Nothing
replaces the site or `site/vendor/` as a whole.

## 3. Copy / build / install plan (root only, after review)

1. Review the authored files and the generator. Fill or confirm every value in `generated/SOURCE-PINS.json`. The six core
   values were copied from root's own earlier pins and still need confirming; nine values are null.
2. `python3 client-site-integration-r1/generator/generate.py` (from `unified-funding-20261028/`). Review the printed hashes
   and `candidate/INSTALL-MANIFEST.json`.
3. Optional diff review: `diff -u ../source/<target> candidate/<target>` for the four patched copies. Each diff should only
   add lines, or add text inside the two `build-site.mjs` lines.
4. Copy into the source checkout. For each patched target, first check that the live file still has `replaces_sha256`;
   refuse if it does not. Then copy each output to its `target` path. Do not copy `INSTALL-MANIFEST.json` into the site.
5. From the source root, run `node scripts/build-funding-vendor.mjs`. It writes `site/vendor/funding.js` and prints its
   sha256 and bundled packages; it needs `viem` and `esbuild` in `node_modules`, both already there. Commit
   `site/vendor/funding.js`, as `.gitignore` says `site/vendor/` is committed.
   **Order matters:** `scripts/build-vendor.mjs` (`npm run build:vendor`) does `rmSync(site/vendor)`, so any later
   `build:vendor` deletes `funding.js` and step 5 has to be repeated. I did not patch `build-vendor.mjs`; root can choose to
   chain the two.
6. `npm run build:site` (existing tooling). Then check that `dist/funding.html` exists, has modulepreloads for
   `js/pages/funding.js`, and that `dist/_redirects` contains `/funding`.
7. With every `FUNDING_*` value null, the deployed `/funding` page should only report that gas funding is not set up and
   that no migration is available. It offers no signing at all. That expectation comes from reading the code; it has not
   been observed.

**Activation needs separate, later root actions, none prepared here:**
- set `FUNDING_RUNTIME` from actual deployment receipts;
- set `FUNDING_MIGRATION_PROPOSAL` to the exact reviewed split;
- only after reviewing the exact plan digest the page displays, set `FUNDING_MIGRATION_APPROVAL`.

## 4. Config objects (operator-set; there is no JSON input on the page)

```
FUNDING_MIGRATION_PROPOSAL = { schema: "enclave-funding-migration-proposal-r1", chainId: 8453, owner: "0x…", oldSid: "0x…",
  legacy6: "29000000", gas: [ { name, budget6, opsPerPeriod, appIds: ["0x…", …] }, … ], deploymentIds: ["0x…", …] }
FUNDING_MIGRATION_APPROVAL = { schema: "enclave-funding-migration-approval-r1", rootReviewed: true, termsHash: "0x…",
  owner: "0x…", chainId: 8453, oldSid: "0x…" }
```

**Proposal rules (`validateProposal`):**
- exact keys;
- the owner and chain must match the connected wallet;
- every part has 1–8 canonical lowercase app IDs; `"*"` is refused (`scope_wildcard`), and overlapping parts are refused
  (`scope_overlap`);
- deployment IDs are an explicit finite list;
- legacy + gas must equal the original exactly and be at most $30.

The TEST shape is 29 + 0.8 (8 apps) + 0.2 (2 apps); it is not approved.

**Approval rules (`approvalStatus`):**
- matched field by field against the freshly built plan (`termsHash`, owner, chain, old sid), with `rootReviewed === true`;
- anything else shows "waiting for review";
- no code path builds an approval, and generating a key never approves anything.

**Legacy scope:**
- comes from the original stored grant, which is required (`loadLegacyEvidence`) and matched on chain by the r4 core;
- `[]` is shown as "no apps", and only `["*"]` is shown as the wildcard;
- nothing is reconstructed from chain flags or widened.

## 5. UI state rules (where each is enforced)

| Rule | How it is enforced |
|---|---|
| Wallet change or remount clears memory | `mount()` bumps an epoch and calls `memory.clear()`; `enclave:wallet` remounts. Every click goes through `act(epoch, owner)`, which refuses when the epoch or owner has changed. |
| Plans and records are scoped | `selectPlans` uses owner + chain + legacy vault + gas vault + old sid. `selectOwnRecords` uses owner + chain + vault + normalized relay. There is never a "latest journal". |
| Signatures are held only for the exact plan | They are held in memory only and bound to context, plan ID, `termsHash` and per-step digests (`signedFor`). They are single use and never persisted. |
| Seven signatures only after approval | Signing only happens after the exact approval matches. |
| Quotes are single use | Quotes are bound to context, record and deployment, and refused within 15 s of the deadline. Fee, maximum, total, balance and time left are shown before any session-key signing. |
| No automatic resend | Step views show friendly labels. Unknown outcomes offer only an explicit "Reconcile", and void steps only an explicit "Re-arm". There is no timer, so nothing is resent automatically. |
| The active pointer never clobbers another choice | `activePointerDecision` moves the legacy pointer only away from the replaced session or from none. Other owners' records are never selected, so they are never mutated. |
| Owner controls work without intake | The controls (end, terminate, withdraw) are rendered first. They depend only on runtime pins, the relay base and the local store, never on intake, the catalog, scope or `/funding/config`. |

## 6. Offline tests

```
cd client-site-integration-r1 && node --test test/
```

These have not been run. They need Node ≥ 20 for `Object.hasOwn`, `node:test` and ESM. They import only `state.js` and read
source text; they do not import the core, viem or the DOM.

## 7. Limitations (stated plainly)

- **Nothing was executed.** The generator, the tests, esbuild, `build-site` and the page have never run. There may be
  syntax or logic errors that only running them will reveal.
- **Assumed r4 APIs:**
  - The page calls r4 core exports by name and shape: `controlsTarget`, `parseRuntimePins`, `verifyRuntime`,
    `freshRecoveryScope`, `loadLegacyEvidence`, `buildMigrationPlan`, `signSteps`, `runMigration`, `reconcileMigration`,
    `rearmStep`, `selectGasRecord`, `quoteGasFund`, `confirmGasFund`, `endGasSession`, `ownerControl`, `IndexedDbV2Store`,
    `relayClient`, `legacyChain`.
  - I wrote those calls from my reading of r4 and did not re-verify every argument shape this stage. A mismatch would show
    up only at runtime. The vendor build checks export names, not shapes.
- **Untested in a real browser or wallet.** The page has not been tested in a real browser or with a real wallet, and the
  real-site router and CSP have not been exercised with it. The earlier browser harness (client-browser-migration-r1)
  tested the core on a test page, not this page.
- **Controls depend on `FUNDING_RUNTIME`.** `/funding` controls for successor gas grants need runtime pins, so while
  `FUNDING_RUNTIME` is null they show "not set up". This is correct because there are no successor grants yet. Original
  sessions keep their controls on `/sessions`, which is unchanged.
- **The gas-recovery section needs the proposal.** It needs `FUNDING_MIGRATION_PROPOSAL` for the deployment IDs.
- **Orphaned keys are not cleaned up.** "Prepare again" makes fresh keys, and keys from an abandoned plan stay in the
  dedicated store.
- **`build:vendor` deletes the bundle.** `npm run build:vendor` removes `site/vendor/funding.js` (see step 5).
- **Intake/activation and production terms are not built.** No production terms, finality choice, approval pin or runtime
  pin is supplied, and no intake or activation flow is built.
- **The core is only as proven as r4.** Its proven status rests on root's earlier runs of the r4 files at the pinned
  hashes. The specifier rewrite should preserve behaviour only if `"viem"` resolves to the same viem version that root
  tested.

## 8. Root review checklist

1. The pins: confirm the six prefilled values and fill the nine nulls. Check that `browser-entry.mjs` still only re-exports
   the four modules.
2. The `generate.py` anchors against the live `boot.js`, `config.js`, `sessions.html`, `build-site.mjs` and `_redirects`.
3. `funding.js` call shapes against the r4 exports.
4. `state.js` rules and the tests.
5. The bundle's viem version matches the one tested in r4 and native.
6. The plan for `build:vendor` versus `build-funding-vendor` ordering.
7. Keep every `FUNDING_*` value null until there are actual receipts and exactly reviewed terms.
