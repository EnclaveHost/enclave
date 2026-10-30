# funding-cutover-r1 production addon: source only, NOT RUN

Written with Read/Grep/Write only. Nothing has been executed, built, tested, uploaded, signed or activated. No production file, source original, candidate, r2 addon, composite or migration-cutover-fault-r2 file was modified. Every file listed here is new in this directory.

## What it is
This is the smallest strict revision of the qualified `production-site-addon-r2` builder for the tested cutover page (root `migration-cutover-site-review-r1`, vendor `f23ba2d7…`). The artifact is still file **additions only**, in the **unchanged r2 format** (MANIFEST `enclave-funding-addon-manifest-r2`, pins `enclave-funding-addon-pins-r2` plus `version`, 4 top entries, 5 additions). That means `production-composite-release-r1/build-composite.mjs` can consume it **unmodified**. Only `version` changes, to `funding-cutover-r1`, and every new path is versioned.

| file | role |
|---|---|
| `lib.mjs` | `export *` of the **unchanged** r2 `lib.mjs` (same function objects). It overrides only `VERSION`, `CONFIG_SCHEMA`, `FUNDING_KEYS` (5), `validateConfig`, `configReplacements` and `validatePins`, and adds `QUALIFIED`, `checkNullExports`, `PAGE_CHAIN`, `APPROVAL_NOTE`. |
| `build.mjs` | r2 `build.mjs` with these diffs only: `--source` is required (the overlay); `--deps` (default `../../source`) is used only to resolve esbuild; r2 `lib.mjs`/`src/entry.js`/`src/hard-nav.js` are read from `../production-site-addon-r2` as pinned inputs `addon:*`; `QUALIFIED` inputs are exact in both modes; `config.js` must declare all five `= null` exactly once; `--out` is refused inside the overlay, live, r2 addon or deps. |
| `make-overlay.mjs` | Isolated overlay. It copies only the **33 files the r2 build read**: 26 baseline files (r2 reviewed sha256), 6 candidate files (page/state/flows/vendor + `funding.manifest.json` content check + `sdk/funding/MANIFEST.json` `838344f7…`) and `config.js` with one exact, reversible patch that adds `FUNDING_MIGRATION_CUTOVER = null` and `FUNDING_CUTOVER_ACTIVATION = null`. It verifies all inputs before writing anything, and verifies the 8 candidate core `.mjs` files in place against MANIFEST.json (they are not copied). It refuses an existing destination and records original/output sha256 and the patch in `OVERLAY-MANIFEST.json`. It copies no package.json, node_modules or symlinks. |
| `config-disabled-cutover-r1.json` | `release: disabled`, all 5 `null`, `humanApproval: null`, empty overrides/acceptLegacy (same as the reviewed r2 disabled config). |
| `config.cutover.template.json` | Cutover-prep template with `<REPLACE…>` placeholders. It is **refused** as is (placeholders, `reviewed:false`). Activation is `null`. |
| `pins.template.json` | All null; refused. |
| `test/lib.test.mjs` | Pure unit tests. |
| `test/overlay.test.mjs`, `test/integration.test.mjs` | Real trees, temp dirs only. They skip if the trees are absent. |

## Config rules (shapes copied from candidate `state.js` / `sdk/funding/migration.mjs`, not invented)
- **disabled**: all five must be `null`, and `humanApproval` must be `null`.
- **enabled** (cutover preparation): requires `reviewed:true` and a concrete runtime (schema only; the SDK parses it). Proposal, approval and cutover may be concrete. **`FUNDING_CUTOVER_ACTIVATION` must be `null`.**
- **activation** (a later, separate rebuild after the actual operation): requires proposal, approval, cutover and activation together.
- Activation without a cutover is refused in every release.
- Each record must have its exact keys and schema. Proposal, approval and cutover `owner`/`oldSid` must match each other, and `chainId` must be 8453 (page `CHAIN`). Activation `termsHash` must equal the approval's, and `activationPlanSha256` must equal the cutover's. Hashes must be lower-case and non-zero; activation and rollback plans must differ; nonce must be uint64. Placeholders are refused.
- **`rootReviewed` is not human approval.** A non-null approval also requires `humanApproval: {termsHash, evidenceSha256}` for the same termsHash, which references the human grant-approval document. The builder records this reference and **does not verify** it. The manifest carries `APPROVAL_NOTE` saying so. No terms, runtime hash, activation or rollback evidence was chosen or invented.

## Root commands (unrun; run from this directory)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/production-cutover-addon-r1
sha256sum lib.mjs build.mjs make-overlay.mjs config-disabled-cutover-r1.json \
  ../production-site-addon-r2/lib.mjs ../production-site-addon-r2/src/entry.js ../production-site-addon-r2/src/hard-nav.js \
  ../production-site-addon-r2/existing-live-paths.txt          # entry 0e8ccaeb…, hard-nav 6598b605…, existing dbeeb6d1… expected
node --test test/lib.test.mjs
node --test test/                                               # + overlay + integration (temp dirs only)
node make-overlay.mjs --out "$PWD/overlay-r1"
node build.mjs --propose-pins --source "$PWD/overlay-r1" --config config-disabled-cutover-r1.json \
  --existing-paths ../production-site-addon-r2/existing-live-paths.txt --pins-out pins-disabled-proposed-r1.json
#   review every sha256 (QUALIFIED, the 26 r2 baseline pins, the new config.js = OVERLAY-MANIFEST outputSha256,
#   addon:lib.mjs, funding.manifest.json, esbuild 0.28.1, config/existing/live); copy with "reviewed": true ->
#   pins-disabled-reviewed-r1.json
node build.mjs --pins pins-disabled-reviewed-r1.json --source "$PWD/overlay-r1" --config config-disabled-cutover-r1.json \
  --existing-paths ../production-site-addon-r2/existing-live-paths.txt --out "$PWD/artifact-disabled-r1"
sha256sum artifact-disabled-r1/MANIFEST.json
```
Composite (unchanged builder; same flags as its README, only addon/pins/sha differ):
```
node ../production-composite-release-r1/build-composite.mjs \
  --base-tree /ABS/ROOT-COPY/site \
  --inventory /home/steven/Documents/Codex/2026-10-23/it/work/restore-queued-20261028/live-site-public/tree-us-west.json \
  --addon "$PWD/artifact-disabled-r1" --addon-pins "$PWD/pins-disabled-reviewed-r1.json" \
  --site-release-dir /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release \
  --base-cid bafybeifidlcmnobifev33hflaicusmzjpcqgwutobbzilaoc6tgylwlzcm \
  --expect-files 1126 --expect-bytes 74403175 \
  --expect-inventory-sha256 9269fe1f19b3d4e32aa109717c8e187ddfd4300294ef1d52e52bfc65642fa372 \
  --expect-addon-manifest-sha256 <reviewed sha256 of artifact-disabled-r1/MANIFEST.json> \
  --base-source-commit 48a812d22 --base-source-dirty true \
  --out /ABS/NEW-DIR-ON-THE-HOME-FS
```
**Staging:** no symlinks are created or needed. esbuild comes from `--deps ../../source/node_modules` via `createRequire`, and nothing else is read from deps. If `overlay-r1/` is left partial by an interruption, the script refuses to reuse it; delete it by hand and rerun.

## What the tests assert (expected; not yet observed)
- **Disabled null:** all five are null and nothing in config.js is replaced. Any non-null value, old 3-key/r2 configs, the template and the pins template are refused.
- **Forbidden activation and mismatches:** activation is refused in `enabled` and without a cutover. Owner, chain, sid, termsHash and plan mismatches are refused. An approval without the human reference is refused.
- **Exact versioned new SDK:** `vendor/funding.funding-cutover-r1.f23ba2d79661ade4.js` with sha `f23ba2d7…` is referenced by the bundle. There is no `funding-r2` or unversioned SDK reference. The legacy sessions SDK `9dda76f6…` is byte-identical.
- **Old build behavior preserved:** the r2 `applyExact`/`planAdditions`/`checkClosure`/`transformHtml` functions are the same objects. Module closure, replacements, config literals, unbaked tags, removed inline scripts and CSS bytes equal the r2 artifact. `funding.html` equals r2's once the versioned names/stamp are mapped.
- **No old-file mutations:** baseline, candidate, r2 addon+artifact, existing listing and live evidence hash the same before and after. The whole old source is refused as `--source`, and r2 pins are refused.

## Open points for review
- Imported code is checked after it loads. `lib.mjs` (r2) and `hard-nav.js` are ESM-imported before their pinned hash check. Both are pure, and the check runs before either is used.
- The `config.js` patch anchor is the exact baseline approval line (`3d687efd…`). If its bytes differ, `applyExact` refuses.
- The integration closure/HTML equality with r2 assumes the candidate page imports the same modules as the baseline page (it does per its import lines). If root sees a difference, that is a finding, not something to suppress.
- This prepares only the deployment artifact. Lost termination, expiry and races stay with `migration-cutover-fault-r2`. Browser qualification of the built addon (README r2 steps 1–7 with this version's paths; disabled page shows no buttons, signatures or POSTs) remains root's. There is no runtime hash, activation, rollback proof or human approval here.
