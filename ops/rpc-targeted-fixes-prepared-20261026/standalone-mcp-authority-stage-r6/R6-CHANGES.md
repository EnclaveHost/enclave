# standalone-mcp-authority-stage/r6 (PREPARED; nothing run by Claude)

**r5 is FROZEN.** Root's preflight `logs/root-mcp-r5-preflight-0315` (rc 0) passed the comparator unit tests 23/23 and found the real r4 artifact builds EQUAL. The 73 tests did **not** run. Run unchanged, r5 would fail: its artifact set lacks MockFeed and EnclaveReviews.

## Changes (product, r2 patch, `R2-PINS.sha256`, `EXPECTED-TAP.txt` (73) and `compare-artifacts.mjs` are unchanged)
1. **`CONTRACT-ARTIFACTS.txt`:** its artifact set is **derived** from `rig-artifact-closure-stage/map/needed-main-mcp.txt` (12), and the runner requires exact set equality.
   - New sources: `contracts/EnclaveReviews.sol` and `contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol` (MockFeed).
   - New required artifacts: MockFeed, EnclaveReviews, and EnclaveAddressBook.
2. **`SOURCE-PINS.sha256`:** 30 files, covering every source plus its full Solidity import closure (forge-std included). Both clones must verify it before any build.
3. **`tests/compare-artifacts.test.mjs`:** one assertion is adapted; there are still 23 tests. The MockFeed source also emits its test contract, which deploys EnclaveDeployments and so carries the same unlinked library placeholders.
   - r5's four `links` entries stay **exact**.
   - Exactly **one** additional linked artifact is allowed, `EnclaveDeploymentsMulticallValueTest.json`. Its slot counts must be positive integers taken from the real build, and its references must be only `contracts/EnclaveDeployments.sol:EnclaveLedgerBandwidth`.
   - No count is invented and no check is weakened.
   - **Other refusals unchanged:** the comparator still refuses any malformed or extra output, any orphan, any wrong compiler, or any wrong source keccak across the WHOLE `out/`, forge-std artifacts included.
4. **Runner `jobs/standalone-mcp-authority-r6-tests.sh`:** r5's runner, plus these checks:
   - r5 is frozen, and the closure stage's `SHA256SUMS` verifies;
   - artifact set == the map's set, and the source pins hold in both clones;
   - `forge` on PATH is the pinned forge, because the rig's `leased()` artifacts are built by the test at run time;
   - private `TMPDIR`/`TEST_TMP` under the run directory.

   It still requires exactly 23 comparator tests and the 73 MCP tests at exact counts. Exit codes: 0 PASS / 1 FAIL / 30 INCOMPLETE / 20 SETUP.

## Known risk (stated, not hidden)
- **Cost:** compiling the Foundry test file compiles forge-std's `Test.sol` closure with via-IR, which is the repo's own setting. Each source is bounded by the existing 1200 s timeout.
- **Possible SETUP outcome:** if forge emits an output the comparator's strict shape rules reject, the run exits 20 SETUP and is never a verdict. Examples are a profile-suffixed artifact name or an orphaned build-info.
