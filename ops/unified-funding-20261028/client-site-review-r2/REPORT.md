# client-site-repair-r2 — REPORT

Status: **SOURCE ONLY, UNREVIEWED, NOTHING RUN.** I used Read, Grep and Write only, and wrote only inside
`client-site-repair-r2/`. I did not run the generator, any test, esbuild, `build-vendor`, `build-site` or a browser, and
there was no network, wallet or signing. I read the prior stages, root's review files, the root log and `source/`, and
changed none of them.

**What is qualified and what is not:**
- The r4 core, the native fixture and the browser-migration harness remain whatever root already qualified.
- This wrapper (page, flows, state, build script, generator) is **unqualified**.
- All terms are TEST terms and not approved. Every `FUNDING_*` value is `null`, and nothing here activates funding or
  builds a signable production activation.

## Root findings → what changed

Root log `funding-site-review-r1-20261028.out`: 24 checks, 19 passed, 5 failed. Root's generator regression also failed
separately (`generator-failure.txt`).

| # | Finding | Fix (file) |
|---|---|---|
| 1 | The generator refused its own build-site patches (`a not in b`). | Every site patch is now **insert-only**, built with `after(anchor, inserted)`, so the replacement starts with its anchor. Each anchor must occur exactly once, and removing the insertions must give back the pinned source exactly. `config.js` and `build-vendor.mjs` are **append-only** (pure-prefix check). The generator refuses unless it lives in `client-site-repair-r2/`, and authored pin paths are `client-site-repair-r2/authored/...`. It refuses to overwrite: a new target that already exists in `source/` stops it. It also writes `ROLLBACK/<target>` with the original bytes and a rollback list in `INSTALL-MANIFEST.json`. Core files still get only the exact, reversible, counted import-specifier rewrites. (`generator/generate.py`) |
| 2 | The re-render after a quote destroyed the displayed quote and disabled fund. | The quote is held in memory bound to: context key, record id, sid, deployment, ETH amount, fee tier, call digest and deadline. The core's own review must state the same deployment, amount, tier and sid, or the quote is refused (`quote_mismatch`). A re-render restores the controls from the held inputs (`quoteInputs`) and shows the quote again without consuming it (`peekQuote`). An input or change event drops it. Fund re-selects the record for the **current** inputs and takes the quote only for those inputs and the digest shown in the DOM (`takeQuote`). It stays single use, with a 15 s margin before the deadline. Remount, wallet or chain change (`memory.clear` / `bind`) drops it. (`state.js`, `flows.js` `quoteFlow` / `fundFlow`, page `renderGas`) |
| 3 | `selectPlans` claimed relay scoping but never checked the relay. | The core's plan terms carry no relay, so I did not invent a terms field. `planScope` now also requires relay evidence: every gas step's `review.recordId` must resolve to a gas key record with this owner, chain, vault and **relay** (normalised), and the same `keyHash`. Those records are created by the same `buildMigrationPlan` call with `relayBase`. No records, missing references, a plan without gas steps, or a mismatch all refuse, with a reason code. The page lists refused same-owner plans without touching them. Reload and reconcile keep working because the records persist in the same IndexedDB. Root's regression calls `selectPlans([plan], c, "sid")` without records and gets `[]`. (`state.js`) |
| 4 | `nextSignable` ignored `proven.recheck`; `signedFor` ignored admitted/proven status. | `nextSignable` skips only *still-proven* steps (proven with no `recheck`). A lost proof stops all later signing. `holdSigned` refuses non-planned steps. `signedFor` returns the bundle only while every held step is `planned` with the same digest and every earlier step is still proven. The core's `runMigration` / `admit` already refused sends in these states; this fixes what the UI *offers*, not an exploitable send path. (`state.js`) |
| 5 | The page displayed the proposal, while an older plan could carry different reviewed terms. | An existing plan is displayed from **its own terms** (`termsView`: original, legacy, part names, budgets, ops, apps, deployment count). `proposalMatchesPlan` compares split, names, order, budgets, ops, apps and deployment IDs. On any difference the page shows which fields differ, and sign/send are disabled in the page and refused again in `signFlow` / `runFlow` (`proposal_plan_mismatch`). Reconcile stays available. `validateProposal` now refuses a total above $30; equality with the actual original balance is still the core's `parseSplit` check. Approval stays a field-by-field match; nothing defaults or bypasses it. (`state.js`, `flows.js`, page) |
| 6 | The wallet epoch was checked only before awaits. | Each click gets a guard (`createGuard`) that snapshots `{epoch, owner, chainId, provider}`; the page's `live()` reads `Enclave.*`. The boundaries handed to the **unchanged** core re-check it right before each effect (see the table below). `signFlow` / `runFlow` / `quoteFlow` / `fundFlow` also check after every awaited read. `wallet.js`'s `accountsChanged` / `chainChanged` handlers call `refreshWallet()`, which emits `enclave:wallet`, so the page remounts; the guard catches the change even before that event arrives. Off Base, migration and gas offer nothing, while controls still render. (`flows.js`, page) |
| 7 | `build-vendor.mjs` empties `site/vendor/`; the funding build wrote before validating. | `build-vendor.mjs` gets one append: `await import("./build-funding-vendor.mjs")` runs after it rebuilds the other bundles, which are not replaced or changed. `build-funding-vendor.mjs` now:<br>1. checks the core manifest;<br>2. builds **in memory** (`write: false`);<br>3. enforces an allowlist that is truthful, not hard-coded: viem plus the dependency closure that viem's installed `package.json` files declare;<br>4. checks the inputs and the exports;<br>5. only then writes `funding.js` and `funding.manifest.json` (bundle sha256, sdk manifest sha256, packages).<br>`build-site.mjs` gets one insert after its vendor copy: it refuses to build when `funding.js` does not match `funding.manifest.json`, or when that manifest was built from another `sdk/funding/MANIFEST.json`. (`authored/scripts/build-funding-vendor.mjs`, generator `PATCHES` / `APPENDS`) |
| — | Author test 8 false positive (`window.` in a comment). | The purity checks strip comments and string literals first; a self-test of the stripper is included. |
| — | Author test 15 expected an OTHER-owned plan to be hidden from OTHER. | That expectation was wrong: the plan belongs to OTHER and is offered only to OTHER, and only with OTHER's own records. The test is rewritten to say that. |

### Guard boundaries (`flows.js`)

| Boundary | After the wallet, chain or page changes |
|---|---|
| `provider.request` (each wallet prompt) | Checked before every prompt. An answer that arrives after the change is discarded. So between the prompts of `signSteps` (7 for the TEST partition), no further prompt is made and no bundle is kept. |
| Successor `relay(...)` and legacy `request(...)` | Non-GET requests are refused. |
| `casJournal` | The core's `mutate` is wrapped inside the same transaction. Refused: any change to a step whose prior status was planned or void (admission, re-arm) and any new entry. Still recorded: outcomes of already admitted steps (submitted, proven, `lastError` notes, rechecks, void). |
| `saveKey` | Only adoption (`status: "open"`) is recorded. |
| `setActive` | Never runs, so the active legacy pointer is not moved for another wallet. |

If the change lands between admission and the POST, the core notes `lastError: context_changed`. The step stays
`admitted`, the page offers only "Check status on chain", and nothing is resent. That is honest but conservative: the
step then waits for the core's chain-time void and re-arm.

## Files (this directory)

| File | Role |
|---|---|
| `authored/site/js/funding/state.js` | Pure state: scoping (`planScope` / `selectPlans` / `selectOwnRecords`), proposal, `termsView`, `proposalMatchesPlan`, money, approval, step views, `nextSignable`, `planPhase`, pointer decision, controls availability, `quoteView`, `quoteInputsOf`, bound memory. |
| `authored/site/js/funding/flows.js` | New. Guards, guarded boundaries, and the sign / run / quote / fund click flows, with injected dependencies. Its only import is `./state.js`. |
| `authored/site/js/pages/funding.js` | The page, rewired to the flows, the guarded step context, authoritative plan display and the persistent bound quote. |
| `authored/scripts/build-funding-vendor.mjs` | Validates before writing, enforces the allowlist, writes the sidecar manifest. |
| `generator/generate.py` | Insert/append-only patches, r2 paths, overwrite refusal, rollback. |
| `generated/SOURCE-PINS.json` | 17 inputs. Six are prefilled from root's earlier pins and need confirming; 11 are null. |
| `test/fixtures.mjs` | Synthetic plan and record fixtures using the core's field names (made-up values). |
| `test/state.test.mjs` | 10 offline tests of `state.js`. |
| `test/flows.test.mjs` | 11 executable boundary tests. |
| `test/generator.test.mjs` | 2 tests that **execute** `generate.py` with `python3` in a temporary layout built from copies of the real pinned inputs. |
| `test/page-source.test.mjs` | 8 source-text wiring checks. |
| `root-review/regressions.mjs`, `root-review/generator-regression.py` | Root's files copied **verbatim**. The relative import path (`../authored/...`, `parents[1]/generator`) resolves to r2 unchanged. |
| `package.json` | `"type":"module"`, tests only. |

### What the tests cover

- **`test/flows.test.mjs`:** the real flow code against a fake core with the r4 effect sequence and an in-memory store
  with the IndexedDB abort-on-throw CAS. It covers:
  - quote → re-render → fund (the displayed digest is the one sent, once);
  - deployment B never funds quote A;
  - changed inputs, remount or a chain switch refuse;
  - no approval, proposal mismatch, another relay or a changed plan → zero prompts;
  - an account switch during the journal read → zero prompts;
  - a chain switch between prompts → stops at 2 prompts and keeps nothing;
  - a send is single use;
  - a switch before send → nothing admitted or posted;
  - a switch after a step was submitted → its outcome is still recorded, nothing new starts, no `setActive`;
  - a switch between admission and the POST → `admitted` with an error note, no POST;
  - guarded store refusals.
- **`test/generator.test.mjs`:**
  - success: output hashes match the manifest; the core reverses exactly; patched files are insert/append-only character
    subsequences of the output with the funding additions present; `replaces_sha256` and the rollback copies match; a
    second run refuses;
  - refusals: drift, a null pin, a wrong pin set, an existing target and a missing anchor all refuse, and nothing is
    written.
  - It skips (it does not pass) if `python3` or an input is missing.

## Run (root)

```
cd client-site-repair-r2
node --test test/ root-review/regressions.mjs
python3 root-review/generator-regression.py
```

Then fill the pins and run `python3 client-site-repair-r2/generator/generate.py` from `unified-funding-20261028/`.

### Install, after review

1. For each output, check the INSTALL-MANIFEST: a patched target must still have `replaces_sha256`, and a new target
   must not exist.
2. Copy the outputs into `source/`.
3. Either run `node scripts/build-vendor.mjs`, which now also builds the funding bundle, or run only
   `node scripts/build-funding-vendor.mjs`.
4. Run `npm run build:site`, which refuses a stale or missing funding bundle.
5. Commit `site/vendor/funding.js` and `funding.manifest.json`.

**Rollback:** restore the 5 patched targets from `candidate/ROLLBACK/`, then delete the new targets and the two built
vendor files, as listed in the manifest.

## Limitations (stated plainly)

- **Nothing was executed.** Every test, the generator, both builds and the page are unrun, so syntax and logic errors are
  possible. Eleven pins are null, so the generator refuses until root fills them.
- **The flow tests use a fake core.** It mirrors the r4 effect order as I read it in `migration.mjs` and
  `funding-client.mjs`. They prove the wrapper's guard and binding rules, not the r4 core, IndexedDB, a wallet, a relay
  or the chain. The real core was not run against the guarded boundaries.
- **The guards assume the core's current effect paths.**
  - They cover effects the core performs through `provider.request`, `relay(...)`, `legacyRelay.request`,
    `gasStore.casJournal` / `saveKey` and `setActive`.
  - They do not cover `legacyStore.save` in `adoptReplacement`: it records the plan owner's proven replacement, which is
    an outcome, not a start.
  - They do not cover the gas key's own P-256 signature in `confirmGasFund`. That signature happens before the guarded
    execute POST and is discarded if the POST is refused.
  - A future core that adds another effect path would not be guarded.
- **The browser harness is not done.** The real page has had no browser run, and I did not write the local-only browser
  harness for it in this round. The quote → re-render → fund path is demonstrated only at the flow boundary and by the
  source checks; a real browser run of `/funding` is still needed.
- **The vendor build is unrun.** I have not run `build-funding-vendor.mjs`. Two of its checks rest on assumptions I have
  not confirmed in a build:
  - the export check parses esbuild's ESM `export { ... }` block;
  - the allowlist assumes the packages are installed at `source/node_modules/<pkg>`. A package hoisted elsewhere would be
    refused (fail-closed).
- **Some plans cannot be used from this page.**
  - A plan prepared at another relay, or whose gas key records are gone, is refused and shown as refused. It cannot be
    reconciled from this page under the current relay; doing so needs a separate, reviewed decision.
  - `termsView` assumes the core's plan shape; a malformed journal entry would break that render.
- **Stale context on a failed re-render.** The page resets `view.c` only on remount. A re-render whose runtime check fails
  keeps the previous context from the same epoch and owner for the gas section. Every effect is still guarded, but
  resetting it on each render would be cleaner.
- **Inherited from r1:**
  - the gas section needs `FUNDING_MIGRATION_PROPOSAL` for its deployment list;
  - "Prepare again" leaves orphaned keys in the dedicated store;
  - the vendor bundle depends on which viem version is installed.
