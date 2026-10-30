# /funding site integration (UNREVIEWED, NOT BUILT, NOT RUN)

Additive only. `prepare.py` stages it under `./staging/` from hash-checked originals; nothing is written into `source/`.

| File | Change |
|---|---|
| `site/js/pages/funding.js` | new page module (copy of `site-patch/js/pages/funding.js`) |
| `site/funding.html` | copy of `sessions.html` with `<title>` and `#ssBody` → `#fdBody` (root should also retitle its visible heading) |
| `site/js/boot.js` | one `PAGES` line: `funding: () => import("./pages/funding.js")` after `sessions` |
| `site/js/core/config.js` | appends `FUNDING_RUNTIME = null`, `FUNDING_MIGRATION_APPROVAL = null`, `FUNDING_RECOVERY_DEPLOYMENTS = []` |
| `scripts/build-vendor.mjs` | default-off block: copies `FUNDING_VENDOR_SRC` to `site/vendor/funding.js` only if its sha256 equals `FUNDING_VENDOR_SHA256` |

The page shares the origin with `/sessions`, so `new S.IndexedDbStore()` opens the same `enclave-sessions` database and the
legacy CryptoKey is used where it is (structured clone, never exported). Successor keys live in `enclave-funding-v2`.

## Build (root, after review)

1. Fill `prepare-expect.json` with the sha256 of the four reviewed originals, then run `python3 prepare.py`.
2. Bundle: `npx esbuild client-migration-r1/lib/browser-entry.mjs --bundle --format=esm --platform=browser --outfile=<out>/funding.js`
   (resolves viem through the relative `source/node_modules` imports). Review the bundle and record its sha256.
3. `FUNDING_VENDOR_SRC=<out>/funding.js FUNDING_VENDOR_SHA256=<sha> node scripts/build-vendor.mjs` in the staged tree.
4. While config stays null/empty the page shows "not configured" and offers no action.

## Enabling (each value only from evidence, never from a proposal)

- `FUNDING_RUNTIME`: `{ schema: "enclave-funding-browser-runtime-r1", chainId: 8453, factory, implementation, gasAdapter,
  legacyFactory, usdc, feeTiers, codehashes: { factory, implementation, gasAdapter }, source: { kind: "deployed-receipts",
  deployTxs: [...], reviewedBy } }`. `verifyRuntime` re-checks codehashes, cross-pins and the relay's `/funding/config`.
- `FUNDING_RECOVERY_DEPLOYMENTS`: the nine ids from `recovery-plan.json` (provisional). Each is re-read from the ledger on
  every page use; a holder/adoption/app mismatch refuses.
- `FUNDING_MIGRATION_APPROVAL`: `{ rootReviewed: true, termsHash }` copied from ONE plan built on the page and reviewed.
  Nonces and signBefore are not part of `termsHash`; the plan must be signed within 600 s of being built, so the same
  terms are rebuilt and their hash compared (the page keeps Sign disabled until they match).
