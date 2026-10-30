# CURRENT STATUS (final r3): offline units PASS (308) + full site build smoke PASS; committed and pushed by root

- **Units:** `root-browser-r3-unit-retry-0021`, rc 0. That is 12 new + 148 baseline + 148 patched = **308 passes**,
  0 offline failures, 0 skips, pre/post source verification PASS. `site-independent-live-reads` is INCOMPLETE: a live
  read-only suite, deferred until the own backend is ready.
  - The first attempt `-0020` (rc 99, memory guard during `git clone`, no verdict) is preserved.
- **Build smoke:** `root-browser-r3-build-0021`, **rc 0** (2560 lane; peak 948 MiB, minimum host available 21960 MiB).
  Evidence is in `root-r3-actual/build-0021-pass/`: the root `.out`/`.guard`/`.rc` and `run/` (both build logs, both
  negative logs, `build-smoke.json`).
  - **Negative builds:** a wrong digest gives exit 1 "…is sha256:…, not the reviewed sha256:0…"; a missing digest gives
    exit 1 "…go together…".
  - **Full private builds:** legacy and own-rpc each produced **236 files / 28.5 MB**. Only the own-rpc dist embeds the
    placeholder fixture (`ownEmbedsFixture: true`, `legacyEmbedsFixture: false`), and the legacy build is unaffected.
    `build-smoke.json` holds the sha256 of every dist file.
  - **DRIFT** (private clones only; reproduced from the actual build): `site/css/site.css` and
    `site/js/gen/contract-artifacts.js` differ from the commit in BOTH builds, because the tailwind and solc-js outputs
    were regenerated. The own clone otherwise shows only the 5 overlaid + 4 added files and the `node_modules` link.
    **No build output was copied to production.**
- **Limits:** the build proves bundling, embedding and refusals only.
  - There was **no browser runtime run and no network proof**.
  - "own-rpc" is a trusted self-hosted transport: the browser does not verify proofs or finality.
  - There is no production authority file and no domain; only the `*.own-node.example` fixture was used.
  - Nothing is deployed and there is no site release or cutover.
- **Root commits** in `relay-consumer-source`, separately; Claude verified both read-only:
  - **`f468b301c`** "Refresh management bundle provenance after history migration": manifest only. It equals the
    regenerated `e6d81012…`.
  - **`81ba66853`** "Add opt-in self-hosted RPC authority for browser reads": 9 files, **each byte-identical to the
    tested r2/r3 source**.
  - **Push** `root-push-browser-runtime-0023`: rc 0, final `[queue] EXIT 0`, output
    `bf77da364..81ba66853 HEAD -> fix/rpc-relay-consumers-20261025` (`root-r3-actual/push-0023/`).
  - **Source ops** `4e77dcfb3` (canonical controls) were already pushed, as reported by root.
- **Current ignore list:** `root-r3-actual/IGNORED-v2.txt`. The original `IGNORED.txt` is kept as the record made while
  the build was active. No dist, compiled output, cache, binary or git objects are published.

---

# SUPERSEDED STATUS (kept as recorded while the build was active): offline units PASS (308 passes); BUILD PENDING (root job active, no rc observed)

- **Root r3 unit job, first attempt** `root-browser-r3-unit-0020`: **exit 99**, stopped by its memory guard during the
  regeneration `git clone` (RSS 541 MiB > the 512 MiB cap; peak at `git`). Its run directory is EMPTY: no suite ran, so
  there is **no fixture verdict**. Preserved in `root-r3-actual/unit-0020-stopped-99/`.
- **Root retry** `root-browser-r3-unit-retry-0021`, same inputs in a new private work dir, 1792 lane: **rc 0**.
  - Guard: peak 954 MiB, minimum host available 22079 MiB (`root-r3-actual/unit-retry-0021-pass/`, all TAP files,
    summary, pins, verify JSON).
  - **Passes:** the new suite **12** + the 14 regression suites **148 on the BASELINE** + **148 on the PATCHED** tree =
    **308 actual passes**, counted from `summary.tsv`.
  - **Failures:** 0 offline failures and 0 skips.
  - **Not run:** `site-independent-live-reads`, written as **INCOMPLETE**. It is a live read-only suite (already
    user-authorized), deferred until the own backend is ready.
  - **Source verification:** pre and post PASS on both trees.
- **Separate baseline fix** (`root-r3-actual/baseline-fix/`): the regenerated `site/vendor/management.MANIFEST.json`
  has sha256 `e6d81012495f6e01cebafab432d64eed7b5dbef7bfc2c0f545e43e5e6bb98863`, together with
  `baseline-management-manifest.patch`, `regen.json` (0 failures) and `regen.out`.
  - The JS is unchanged at `05209546…`.
  - Only provenance changed. Commits were recomputed by the unmodified tool from the full history, and every
    `committedClean` is now true; two sources were previously false.
  - It is separate from the browser patch.
- **Coordinators:** `root-r3-actual/coordinators/`: `jobs/root-browser-r3-0020.sh` (its build step never ran after the
  99) and `jobs/root-browser-r3-retry-0021.sh`.
- **Build smoke** `root-browser-r3-build-0021`: **PENDING.**
  - It is ACTIVE in the 2560 lane (`npm_config_offline=true`, `npm_config_yes=false`).
  - The negative builds have already been refused as expected.
  - No ended rc had been observed when this was published. Its logs and private dist are not published
    (`root-r3-actual/IGNORED.txt`).
- **Not done:** no patch applied, no commit, no runtime change. Root applies the patch to the product branch only
  after the full build passes.

---

# CURRENT STATUS (r3): r2 ACTUAL new 12/12 PASS; the only failure is the SAME stale baseline vendor provenance; r3 fix PREPARED, NOT run

- **Root r2** `root-browser-authority-r2-0013`, rc 1 (`root-r2-result/`, preserved).
  - **Passing:** the new suite **12/12 PASS**; 13 of 14 regression suites PASS on both the baseline and the patched
    tree.
  - **The only failure, identical on BASELINE and PATCHED:** `site-independent-management-unit` 27/28.
    - The committed `site/vendor/management.MANIFEST.json` carries per-source commits (`3542e180…`, `b3256349…`,
      `c2bc3cc6…`) that are not in the repository history after the user-requested history rewrite.
    - The bundle is byte-identical (70230 bytes, `05209546…`).
    - This is stale baseline data, not a browser-authority regression.
  - **`site-independent-live-reads`:** INCOMPLETE. A live read-only suite (already user-authorized), deferred until the
    own backend is ready.
- **r3 (`r3/`, `MANIFEST.sha256` `fe89250a…`; NOT run):**
  - `jobs/root-r3.sh` regenerates ONLY that manifest with the unmodified `scripts/build-management-vendor.mjs`, in a
    fresh full-history clone.
    - It validates that the JS bytes and every non-provenance field are unchanged, with commits recomputed from git;
      no hand-written IDs.
    - It emits the regenerated manifest and patch as a SEPARATE baseline fix.
    - It then runs the FULL offline baseline + patched suites.
  - `jobs/root-r3-build.sh` is a site build smoke (legacy, plus own-rpc with a placeholder fixture) in private clones,
    with negative digest builds first.
- **Unchanged:** the product patch is identical to r1/r2. Nothing is built or deployed, and there is no cutover.

---

# CURRENT STATUS (r2): root r1 FAILED (fixture/harness only); r2 fixture+harness repair PREPARED, NOT run; product patch unchanged

- **Root r1** `root-browser-authority-tests-0008`, rc 1 (`root-r1-failed/`: root `.out`/`.guard`/`.rc` + the run directory,
  preserved). 13 regression suites passed.
  - **New suite 7/11:** the fixture copied only `site/js`, but `independent.js` imports `../../../network/*.mjs`.
  - **`site-independent-live-reads` 6/6 SKIPPED:** a live-network suite.
  - **`site-independent-management-unit` 27/28:** the vendored bundle's provenance commit was null in a history-less
    `git archive`.
- **r2 (`r2/`, `MANIFEST.sha256` `ab5b1a94…`, patch `browser-read-authority.r2.patch`):**
  - **Fixture:** it copies the REAL import closure (122 files incl. `network/`) with `node_modules` linked; no product
    module is stubbed.
  - **Trees:** private full-history `git clone --no-local` trees at `bf77da364`, one patched and one pristine BASELINE.
  - **Tree verifier:** `verify_tree_v2.py` = `verify_tree.py` + `.git`/HEAD/`git status` checks.
  - **Live-reads:** reported as explicit **INCOMPLETE** (needs public Base RPC), never a pass.
  - **Product:** the 8 product/doc files are byte-identical to r1; only the test file changed.
- **Root command:** in `r2/README.md`. **No actual r2 result yet.** Nothing is built or deployed, and there is no
  cutover.

---

# Browser / site read authority: PREPARED opt-in own read authority (NOT run, NOT built, NOT deployed, NO cutover)

**What this is:** source, tests, a reviewable patch and docs only, against `relay-consumer-source` `bf77da364373a9c7…`.
- **Not done:** no queue, build, SSH, web wallet, live access or commit.
- **No actual test results yet:** root's integration and test run are pending.
- **Contents:** `stage/` is a byte copy of `browser-authority-stage/` without its private tree
  (`MANIFEST.sha256` `27367c770185f559…`, patch `c97e15b843043cb8…`).

## Consumers and how this patch treats them (exact paths at `bf77da364`)
| consumer | read path | in this patch |
|---|---|---|
| site / dashboard catalog, ledger, featured, reviews, payments, network page, address book | `site/js/core/config.js` `APP_CATALOG_RPCS` → `chain.js` `baseRpc` (`addressbook.js` iterates the same pool) | **covered:** a release read authority replaces the pool, so only own endpoints are used |
| wallet read fallback (balances when the wallet cannot answer) | `wallet.js` `fallbackRead` (legacy `mainnet.base.org`) | **covered:** uses the pool under an authority; legacy unchanged |
| hosted sessions chain client | `sessions.js` `rpcFor` (relay config rpc, else pool[0]) | **covered:** own-rpc uses only the pool (a relay-supplied rpc is ignored); invalid refuses |
| wallet SIGNING RPC (`addChainRpcs`, WalletConnect `rpcMap`), owner-chosen bundler (`passkey-account.js`) | wallet / user choices | **out of scope; unchanged** |
| independent mode (saved or built-in profile; `quorum.js`, `independent-chain.js`) | the user's explicit profile | **unchanged; takes precedence** |
| credit page (`site/credit/credit.js`, `credit-config.json`) | quorum reader (at least 2 origins, quorum at least 2) | **config-only**: an own-authority credit release needs two own endpoints in `credit-config.json`. A test pins that no single-endpoint shortcut exists |
| mobile shell (`enclave-apps/mobile-shell`) | wraps the site and `api.enclave.host` | follows the site release |
| browser owner startup (`startup-package.js` history RPCs) | guest-side history sources the owner lists | out of scope (guest config) |
| cold bootstrap (`network/cold-bootstrap.mjs`) | node-side; already has an explicit `chainAuthority: 'verifier'` path | not a browser consumer |

## Trust and activation (do not overstate)
- **"own-rpc" is a trusted self-hosted transport.** It is HTTPS JSON-RPC to the operator's own Base node, and the
  browser does not verify proofs or finality. That is the same as today's public pool, minus the third parties.
- **It is not** the local proof verifier (loopback-only on hosts) or an attested route. No in-browser proof seam exists
  at this commit; that would be a separate design.
- **Production activation is root's decision on a qualifying backend:**
  - the own node is synced and has passed its gates;
  - it is served over HTTPS with CORS for the site origin;
  - its answers are cross-checked;
  - a reviewed authority file and digest are passed to `scripts/build-site.mjs`;
  - an ENS/IPFS site release follows.
- **No production domain or endpoint is invented here.** The tests use `*.own-node.example`.

## Fail-closed properties (as written; tested only once root runs the suite)
- **Pool:** an own-rpc release reads ONLY the listed endpoints, with no public pool and no dev override.
- **Outage:** the bounded rotation stays on those endpoints, then errors.
- **Invalid or mislabelled authority** (http, credentials, query, a third-party provider host, a duplicate or unknown
  key, a trust value other than `self-hosted-transport`, 0 or more than 4 endpoints, more than 4 KiB): the pool is
  empty and every read refuses.
- **Build:** a digest mismatch or a combination with `--built-in-profile` fails the build.

See `stage/README.md` for the changed files, the tests, the regression list and the root command.
