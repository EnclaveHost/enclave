# Rig artifact closure — result (PREPARED; nothing run by Claude)

**What Claude did:** read-only static scans plus `ast`/`bash -n`/`node --check`, and sha256.
- **Not done:** no tests, builds, queue jobs, network or SSH access, live actions or commits.
- **Untouched:** composition r12 (stage `SHA256SUMS` verifies; its run directory and test trees are only read) and MCP r5 (`SHA256SUMS` verifies).

## Actual failure
- **The failure:** in `logs/root-composition-r12-full-0313.out` (still running), `leaseRelay test/lease-relay-host-policy.test.mjs` reports `BASELINE-NOT-CLEAN` (fail=9) in both the component and final trees. Every test failed with `hookFailed`, `ENOENT …/contracts/foundry/out/EnclaveDeployments.multicallValue.t.sol/MockFeed.json`, at `art` `test/helpers/cli-independent-rig.mjs:35` ← `startRig :129` ← `lease-relay-host-policy.test.mjs:224`.
- **Cause:** the rig deploys the Foundry suite's `MockFeed`, which lives in the TEST source `contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol`. r11/r12's B2 subset (9 sources, 33 artifacts) never compiles that file.
- **Unrelated r12 failures, not touched:** the same log also shows `[FAIL] regeneration touched non-generated files: contracts/foundry/out/…` (phase D) and `verifier test/attested-chain-verifier.test.mjs REGRESSION` (14/15).

## Finite artifact map (`rig-artifact-closure-stage/map/ARTIFACT-MAP.{tsv,md}`)
- **Coverage:** 147 test closures: the 5 MCP files (73 tests) plus the r2 patch, and r12's 28 component tests (own trees) plus 104 regressions (final). The result is 28 artifacts in two roots.
- **`contracts/foundry/out`** (prebuilt, 16 artifacts):
  - AddressBook, AppCatalog, Deployments, LedgerBandwidth, HostOwnership, Registry, **Reviews**, PaymentRouter, PinnedSessionVaultFactory, SessionVault, SessionVaultFactory, SessionVaultLib;
  - SessionMocks: MockUSDC3009, Mock1271Owner, SessionRegistryStub;
  - **MockFeed (`.t.sol`)**.
- **Test runtime build** (`test/helpers/lease-gas-forge.mjs` → `$TMPDIR`, 12 artifacts): Deployments, LedgerBandwidth, Registry, LeaseExecutor, LeaseGasReserve, MockFeed, MockUSDC, SessionVault ×3, SpoofOperator ×2. These are not prebuilt; they need the pinned `forge` on PATH and a private TMPDIR.
- **Dynamic references:** the only one is `leased(file, name)` (mcp-independent-rig.mjs:27), a wrapper of `leaseArt`, resolved through its literal call sites. Nothing is left on HOLD.
- **MCP needs 12 main-out artifacts.** r5 lacks MockFeed, **EnclaveReviews** (mcp-independent-rig.mjs:60; its source is not compiled at all) and EnclaveAddressBook (compiled, but not required).
- **r12 needs 15.** Only MockFeed is missing from what r12 actually produced.
- **Sources:** each source and its full Solidity import closure (forge-std included) is pinned. That is `SOURCE-PINS-mcp-b6ac5d657.sha256` (30 files) and `ADDED-SOURCES-r12.sha256` (22 files), with 0 unresolved imports, verified in the actual trees.
- **Contract input closure:** identical (`d8b3d3125991`) in all 7 r12 trees.

## Prepared
1. **`rig-artifact-closure-stage`:** `SHA256SUMS` `bdc8ae2a…a0e`, 22 files.
   - **Runner:** `jobs/root-r12-impacted-rerun.sh`, run after r12 finishes:
     ```
     ./jobs/q-exit-status.sh r12-impacted-rerun 2560 unshare -rn bash rig-artifact-closure-stage/jobs/root-r12-impacted-rerun.sh
     ```
   - **What it does:**
     - derives the missing set, which must equal `map/r12-missing.txt` (otherwise HOLD, exit 20);
     - selects only rows that are not ok, statically reach MockFeed, and show that ENOENT in their actual receipt;
     - `cp -a` copies just those trees and checks each copy's HEAD, porcelain (including ignored files), `out/` manifest and source pins;
     - builds the one source with the pinned forge 1.7.1 / solc 0.8.35, offline and `-j 1`;
     - gates the build: pre-existing artifacts keep identical bytecode objects, tracked files are unchanged, MockFeed is present with an exact target and solc version, and its bytecode is identical across copies;
     - reruns ONLY the unclean pairs, with r12's exact command; each must match the r12 receipt's `# tests N` exactly;
     - writes `RESULTS-AMENDED.tsv` covering every row.
   - **Exit codes:** 0 only if nothing else is failing. **3 if unrelated r12 failures remain**, which is expected given the two above. 1 if a rerun fails; 20 SETUP.
   - **Expected selection:** `lease-relay-host-policy` (leaseRelay and final). Tests that reach the rig but passed, such as `storage-front-binding-release` (5/5), are NOT rerun. Regression rows will be selected only if their actual receipts show the ENOENT.
2. **`standalone-mcp-authority-stage/r6`:** `SHA256SUMS` `190f9ac9…ff0f`.
   - **Artifact set:** derived (12) and checked equal to the map.
   - **New sources:** EnclaveReviews and the MockFeed `.t.sol`, plus `SOURCE-PINS.sha256`.
   - **Runtime checks:** `forge` on PATH must be the pinned forge, with a private TMPDIR.
   - **Comparator:** unchanged. Its tests stay at exactly 23. One real-tree assertion is adapted: r5's 4 link entries stay exact, and exactly one new entry is allowed, the MockFeed file's test contract. It must have positive counts from the real build and only the ledger-library reference.
   - **Unchanged:** the 73 MCP tests and their counts.
   - **Runner:**
     ```
     ./jobs/q-exit-status.sh standalone-mcp-authority-r6 2560 unshare -rn bash standalone-mcp-authority-stage/r6/jobs/standalone-mcp-authority-r6-tests.sh
     ```

## Risks / not claimed
- **Cost:** compiling the `.t.sol` compiles forge-std via-IR. Each source is bounded by a 1200 s timeout.
- **Possible SETUP:** forge output shapes the strict comparator rejects (a profile-suffixed name, an orphaned build-info) would give SETUP 20, never a fake pass.
- **Not claimed:** no MCP 73 PASS, no r12 PASS, and no new comparator PASS. The only actual passes are root's r5 preflight (23/23 and EQUAL on the r4 builds).
- **Holds:** Custody v2 stays REFUSED; lease consumers stay on HOLD.
