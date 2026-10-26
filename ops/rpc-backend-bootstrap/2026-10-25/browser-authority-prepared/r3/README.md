# browser-authority-stage r3: baseline vendor-provenance regeneration + site build smoke (PREPARED; NOT run)

## Root r2 actual result (preserved; r1 and r2 sources and logs untouched)
- **Run:** `root-browser-authority-r2-0013`, rc 1 (`../r2/logs/root-browser-tests-r2-20261026T001351Z/`).
- **New suite: 12/12 PASS.** 13 of the 14 regression suites PASS on both the baseline and the patched tree.
- **The only failure is the same on BASELINE and PATCHED:** `site-independent-management-unit`, 27/28.
  - The fresh vendor build's per-source `commit` differs from the committed `site/vendor/management.MANIFEST.json`.
  - The bundle is byte-identical (70230 bytes, sha256 `05209546…`).
  - The manifest's commits (`3542e180…`, `b3256349…`, `c2bc3cc6…`) are NOT in the repository history: the
    user-requested history rewrite left stale provenance. Two sources were also recorded `committedClean: false`.
  - **This is stale baseline data, not a regression from the browser authority patch.**
- **`site-independent-live-reads`:** INCOMPLETE. It is a live read-only suite (`ENCLAVE_LIVE_READS=1`, public Base RPC;
  already user-authorized), deferred until the own backend is ready.

## r3 job 1: `jobs/root-r3.sh` (queue 512; regeneration + the FULL offline suites)
1. **Fresh private full-history clone** (`git clone --no-local`, detached at `bf77da364`, `node_modules` linked). The
   pinned inputs are checked first: `management.js` `05209546…` and the stale manifest `61798129…`.
2. **Regenerate:** the UNMODIFIED `node scripts/build-management-vendor.mjs` runs, without `--allow-uncommitted`. No
   commit ID is hand-written.
3. **Validate** (`jobs/check_manifest_regen.py`). It requires:
   - JS bytes unchanged (equal to the pin and to the manifest sha256);
   - file, sha256, bytes, entry, esbuild, deps and every source sha256 unchanged, and the same source set;
   - each commit recomputed independently (`git log -1 -- path`), an ancestor of HEAD; `committedClean` true;
   - clone status exactly ` M site/vendor/management.MANIFEST.json` (plus the `node_modules` link).
4. **Outputs:** `management.MANIFEST.regenerated.json` and `baseline-management-manifest.patch` are the SEPARATE
   baseline fix, not part of the browser patch.
5. **Trees:** two fresh clones, baseline (`REV` + manifest fix) and patched (+ the unchanged r2 browser overlay). The
   runtime pins are derived from the r2 pins plus the regenerated sha; `verify_tree_v2.py` checks them pre and post.
6. **Suites:** the new suite (patched) plus 14 regression suites on the baseline and again on the patched tree. Zero
   skips; any failure gives exit 1. Live-reads is written as INCOMPLETE.

## r3 job 2: `jobs/root-r3-build.sh` (queue 2048 recommended; a separate job)
- **Setup:** private clones `build-legacy` (`REV`) and `build-own` (`REV` + the r2 overlay).
  - `build-site.mjs` deletes `<clone>/site/dist` BEFORE parsing its arguments, so the negative builds run first: a
    wrong digest and a missing digest must be refused.
- **Builds:**
  - legacy: `node scripts/build-site.mjs`;
  - own-rpc: `--read-authority fixtures/own-rpc.authority.json --read-authority-digest sha256:ed5175f7…` (placeholder
    `*.own-node.example` only).
- **Dependencies:** the build compiles contracts with the local solc-js 0.8.35 and runs the local tailwind CLI. No
  network is expected, and nothing is installed; a failure is reported.
- **Check (`check_build_smoke.py`):**
  - the own dist embeds the fixture host and the legacy dist does not;
  - both dists are hash-indexed;
  - each clone's `git status` after the build is reported as DRIFT (an observation for review).
