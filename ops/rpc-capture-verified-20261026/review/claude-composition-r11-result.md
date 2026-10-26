# Composition r11: baseline fixes, real per-tree fixtures, shared exact receipts and preflight (prepared; nothing run)

Stage: `rpc-runtime-composition-stage/r11/` (SHA256SUMS `ab3d9b9602361485…`); runner `jobs/r11-build-validate.sh` `f56b8fdfe213b355…`.
- **Preserved:** r10 and every earlier stage are frozen, and the runner verifies r9/r10 and the baseline-fix stage by hash. The running MCP r3 inputs were not touched.
- **What ran here:** git reads, `bash -n`, the static depgraph and loss audits, and `git apply --check` through temporary indexes. No tests, builds, queue, network, SSH or upstream commits.
- **No production qualification is claimed.**

## Candidate `refs/r11/candidate` **2d56a4b193a8f3e0be1b343a1e06970fc193d9f9** (private; parent r10 7371ee06)
- **Exactly one file:** `test/native-relay-chain-authority.test.mjs`, via composition-baseline-fixes-stage `patches/native-relay-remote-verifier-refusal.patch` (654b3f17; that stage's SHA256SUMS is pinned).
  - bf77da364 moved the remote-verifier refusal **earlier** (the fleet's relay chain authority, relay/dns-relay.js:88-89).
  - The test now asserts that exact message, **that no app-zone reader was built, and that no verifier was asked**. This is stricter; no product file changed.
- **Carried from r10:** its fixes (the provider host-services refusal under the local verifier, the restored `challengeOptions`, credit 12b41d459's exact 4 files, all six triage corrections).
- **MCP:** not composed. **Seam:** the r2 patch applies cleanly to r11 (checked), and the 3 MCP source files in r11 equal b6ac's. `tools/append-mcp-seam.sh <receipt> <sha>` creates `refs/r11/candidate-mcp` only from a pinned `RESULT: PASS` with 8 exact rows (73/73).
  - **Note:** MCP r3 (root-mcp-authority-r3-0300) **ended SETUP rc 20**. Its two forge builds differed **only in out/build-info/** (per-build ids); all 31 contract artifacts were identical. Its identity check needs the same build-info exclusion r11 uses, in a new MCP stage (r3 frozen).

## New runner phases (all r10 gates kept: native inputs with no skip, exact paths, staging, summaries, regressions, stack, closures)
- **B2 fixtures in EVERY tree** (component baselines included):
  - **the ignored network runtime** (`node relay/build-network.mjs`, its sha in the setup hash);
  - **the pinned OFFLINE forge subset** (CONTRACT-ARTIFACTS.txt): 9 sources and 14 artifacts, derived from every rig's `art()`/`artifact()` calls and direct `out/` reads (cli-independent, mcp-independent, independent-browser, fork-deploy, lease16d (storage-front), sessions-chain; lease-relay-host-policy, cli-independent-login, …);
  - forge 1.7.1 4f77da08 and solc 0.8.35+commit.47b9dedd fa8ac9a3 (`--use`, `--offline`, `-j 1`, one source per invocation), with the repo's own foundry.toml (compile settings untouched);
  - anvil and openssl are required.
- **Per contract-input closure** (`git ls-files -s foundry.toml contracts`):
  - **two independent builds** whose contract-artifact manifests must be identical, **excluding out/build-info** (bookkeeping ids, the MCP r3 finding);
  - other trees with the same closure get verified copies;
  - every artifact whose source exists in a tree must have bytecode.
  - The final tree's ignored `contracts/foundry/{out,cache}/` are allowed in the untracked check; stage_exact never stages them.
- **B3 test overlay:** the same reviewed patch is applied to every component tree whose test is its exact pre-image. The baseline is the component's own product with the corrected assertion, never the candidate's result.
- **Shared exact receipts:** key = sha256(tree commit, test path, **test file sha256**, **setup hash** (the 3 dependency treehashes + that tree's artifact manifest + its network runtime), overlay list).
  - **Reuse:** E and E2 (or any repeat) on the same tree and file reuse one stored output (receipts/RECEIPTS.tsv, REUSED.tsv). **A different tree never shares a key**, so no baseline is borrowed and no test is omitted.
  - **Final tree:** its setup hash is recomputed after regeneration.
- **`--preflight`:** runs A (including the auditor fixture tests), B, B2 and B3, then stops before any generator or test. It catches setup, pin, fixture and audit errors before the long suite.

## Source-loss review (r11 versus every source head; `HEAD-LOSS.json`, `HEAD-LOSS-ROUTE-REFINED.json`)
- **Method:** lines unique to a head (in no other head's version and not in base 7752) that are absent from r11. For route the stricter r3 criterion applies (not in any lineage state since adf9c5bbf).
- **Results:**
  - **consumers-credit:** 3 files (the 2 regenerated bundles; chain.mjs = the r9 union replacing the TX_RPCS path);
  - **leaseRelay:** 7 (bundles/manifests that will be regenerated; 3 test files covered by the r3 seam unions);
  - **verifier:** 6 (attested-authority/client = the r3/r7 unions; the measured-control test = the seam's stricter form; the regenerated bundle);
  - **route:** 24, every one a reviewed decision:
    - the generated bundles;
    - the r9 Windows authority union (chain/chain-reader/host-onchain/network-enroll/agent/host and their test and driver);
    - the r3-proven older forms (overlay-control-image, metal-control-overlay test, build-image, api-relay, supervisor, metal/README, measured-control OPTIONAL_MEMBERS);
    - the r10 provider-mode adaptation (attested-authority, route test);
    - the lineage-kept docs and builder (measured-control-guest.md, hosted-mcp.md, build-mcp-guest-bundle);
    - the r2 challenge-replica `hostPolicyGateEnv` re-export not adopted (REVIEW);
    - e4f's ownerSignatureReader.
- **No unreviewed route-unique code loss was found.**

## Root
    ./jobs/q-exit-status.sh rpc-runtime-composition-r11-pre 2560 unshare -rn bash rpc-runtime-composition-stage/r11/jobs/r11-build-validate.sh --preflight
    ./jobs/q-exit-status.sh rpc-runtime-composition-r11-1 2560 unshare -rn bash rpc-runtime-composition-stage/r11/jobs/r11-build-validate.sh
- **Queue:** 2560 (allowed values; r10 peaked far lower, and forge one source at a time measured 117 MiB). **4096 is the maximum if root prefers.**

## Not established
- **Not executed:** the new phases (fixtures, overlay, receipts, preflight) and the r10 code have not run.
- **Unknown until a run:** whether the copied artifacts satisfy every rig, and whether the remaining ~98 regressions, the stack tests and the native tests pass.
- **Byte-identity of artifacts:** two-build identity across different heads with the same closure is required, not assumed.
