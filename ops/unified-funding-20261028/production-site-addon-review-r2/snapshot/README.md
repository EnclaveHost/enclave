# funding-r2 production site ADDON (source only)

Standalone `/funding` for the live site as **file additions only**. Nothing here has been run, built, uploaded or activated.

## Files
- `build.mjs` — builder (propose-pins / build). Reads the source checkout (`../../source`) and live public evidence; writes only a fresh `--out` dir (or one `--pins-out` file), never overwriting.
- `lib.mjs` — pure checks/transforms (exact replacements, config, bake, closure, externals, collisions).
- `src/entry.js`, `src/hard-nav.js` — the only new module code bundled into the artifact.
- `config.template.json` — disabled release, all `FUNDING_*` null. `pins.template.json` — all null (refused as is).
- `test/lib.test.mjs` (unit), `test/integration.test.mjs` (real source + esbuild + live evidence, temp dir; skips if absent).

## Root lane
```
node --test test/
node build.mjs --propose-pins --config CFG.json --existing-paths CID-PATHS.txt --pins-out pins.proposed.json
#   review pins.proposed.json (every input sha256, esbuild version, config/existing/live shas), set "reviewed": true -> pins.json
node build.mjs --pins pins.json --config CFG.json --existing-paths CID-PATHS.txt --out OUT
```
`CID-PATHS.txt` = one path per line of the immutable production tree (bafybeifidlc…). `--css live` keeps the page on the existing `/css/site.css` instead of shipping the source `site/css/site.css` under a versioned name.

## What the artifact is
`OUT/site-additions/`: `funding.html`, `js/funding-r2/funding.<h16>.js` (one ESM bundle, no splitting), `vendor/sessions.funding-r2.<h16>.js` (source legacy SDK `9dda76f6…`, byte-identical; live global `/vendor/sessions.js` b6125577… untouched), `vendor/funding.funding-r2.<h16>.js` (byte-identical, checked against `funding.manifest.json` + `sdk/funding/MANIFEST.json`), and in `--css source` mode `css/site.funding-r2.<h16>.css`. Also `ADDITIONS.json`, `ADDITIONS.sha256` and `MANIFEST.json` (every input sha256, the module closure, each replacement with reverseEqual, config literal statuses, externals, removed inline-script hashes).

The only source edits are exact, reversible replacements that must match once:
- `pages/funding.js` `import("/vendor/funding.js")` → versioned path
- `core/sessions.js` `import("/vendor/sessions.js")` → versioned path
- `wallet-button.js` `navigate` import from `../../js/boot.js` → `src/hard-nav.js`; `core/wallet.js` `import("../boot.js")` → the same hard nav (`dashboard`, `checkout` only, via `location.assign`)
- `config.js` only for reviewed `overrides` and concrete `FUNDING_*` values (`release: enabled` + `reviewed: true` + a non-null `FUNDING_RUNTIME`; an approval is accepted only as supplied with `rootReviewed: true` alongside its proposal).

## Refusals
The build refuses:
- a null or unreviewed pin, or any input whose hash differs from its pin
- an unused pin
- an import of `boot.js` (resolver error), other pages, test/fixture/mock paths, or inputs outside `site/js`, `site/components`, `sdk/`, `node_modules/` and addon `src`
- a module loaded outside the pinned loader
- an unversioned `/vendor/sessions.js` or `/vendor/funding.js`, or any other external that isn't a `/vendor/*.js` in the existing tree
- vendor bundles that import same-origin modules
- `config.js` endpoint/address literals that are in none of: the live chunks, `overrides`, `acceptLegacy`
- an addition that collides with an existing file or directory (case-insensitive), or that has a traversal or unsafe shape
- symlinks
- an existing `--out`
- output inside the source or the live evidence
- a document link, CSS `url()` or hard-nav target that isn't in the existing tree
- any executable inline script in the output document

## Known deviations / notes for review
- The source `funding.html` inline view-transition script, and build-site's `WALLET_PAINT`/`SKEW_HEAL`, are **dropped**. That means no new CSP hashes. Effect: the header shows "Sign in →" until hydration, with no soft-enter animation. Their hashes are recorded in the manifest.
- Header nav anchors are plain links. No router is loaded, so they are full document loads. The wallet-button "Sign in" path still calls `navigate("dashboard")` as it does on every page (now a hard load). The page's own `#fdConnect` connects without navigating.
- Old `boot.js` is not used, so anything it initialized globally (e.g. the address-book refresh) does not run here. The funding flows use `FUNDING_RUNTIME` pins, not book addresses. Confirm this in the browser (below).
- `/funding` pretty URL: whether the live `_redirects` rewrites `/funding` → `funding.html` is not changed here. `_redirects` is an existing file. If it doesn't, the page is reachable at `/funding.html`.
- The legacy `config.js` literals (`api.enclave.host`, RPC pool, address book/catalog/deployments, IPFS, custody committee) must each be found in the captured live chunks or be explicitly overridden/accepted in the reviewed config. Nothing is accepted by default.

## Browser qualification next (exact https://enclave.host origin, same profile; mock-browser fixtures first)
1. Load `/funding.html` (and `/funding` if rewritten). Check:
   - 200s with `text/javascript` for the bundle and both versioned vendors
   - no requests to `/js/boot.js`, `/js/chunks/*`, `/vendor/sessions.js` or `/vendor/funding.js`
   - no CSP violations; console clean.
2. Header/footer/section-head render pre-JS (baked). After hydration, `c-wallet-button` hydrates (no re-render flash beyond "Sign in →"), the toast host exists, and `#walletPick` is portaled to `<body>`.
3. With an existing wallet session:
   - silent restore via `Wallet.init`/`restoreSession` happens with no wallet prompt
   - `localStorage.enclave_wallet_session` is unchanged
   - IndexedDB `enclave-sessions` v1 `keys` is opened without upgrade, and no record is written, removed or recreated
   - `enclave:wallet` re-mounts `#fdBody`.
4. With no wallet: `#fdBody` shows "Connect wallet"; clicking it prompts only for account connection (no signature).
5. Disabled config: Controls show "Gas funding is not set up…", Migration shows "no deployed successor…", Gas shows "Not available here". Zero signature prompts and zero relay POSTs.
6. The wallet popover "Sessions" link, "Add credit" (→ `/checkout`) and header nav links do full document loads to existing pages, and Back returns to `/funding`.
7. Old pages (`/`, `/dashboard`, `/sessions`) still load the unchanged live `/vendor/sessions.js` (b6125577…) and keep their session after visiting `/funding`.
8. Once a reviewed enabled config exists: rebuild with new pins, then repeat 1–7 plus the ROOT-REVIEW phase set (controls, executions read-only check, migration review gating, quote/fund) against fixtures before live activation.
