# Composition r10: the six root-triage fixes, the two real candidate regressions fixed, credit 12b41d459 composed (prepared; nothing run)

Stage: `rpc-runtime-composition-stage/r10/` (SHA256SUMS `8bad0ebf867804ae…`); runner `jobs/r10-build-validate.sh` `84643f953f74dcb5…`.
- **Preserved:** r9 (stage and run) is untouched.
- **What ran here:** git reads, `node --check`, `bash -n`, the static link checks, and a dry run of the summary parser on a real r9 log and synthetic logs. No tests, builds, queue, network, SSH or upstream commits.

## Candidate `refs/r10/candidate` **7371ee06766a4c297d68adbd77a40a7af33f605e** (private; parents r9 82ec7d45 + consumer 12b41d459)
| file | change | why |
|---|---|---|
| scripts/build-site.mjs, site/credit/credit.js, site/js/core/read-authority.js, test/credit-read-authority.test.mjs | consumer **12b41d459 exactly** | root 0228 (12/12), 0230 (both credit bundle modes), 0232 applied; the first 3 were untouched by the composition (r9 blob == b6ac); receipts pinned (CREDIT-RECEIPTS.sha256) |
| network/wg-provider/attested-authority.mjs | **host services under the provider's local-verifier mode are REFUSED** ("never mixed"); the chainVerifier refusal text is restored to route's wording | **real regression #1** (r9 attested-route-composition test 1). The verifier lineage (e0dfe98aa; attested-chain-verifier.test.mjs:366) has the local-verifier provider mode and route removed it. In r9, `providerHostPolicyRuntime` sent that mode into the quorum branch, so the policy was read through the policy's own RPCs: a **mixed authority**. The mode is kept (verifier-lineage test) and can no longer carry host services |
| network/enclave-network-host.mjs | route's `challengeOptions={}` parameter restored on `createNetworkHost` | **real regression #2** (r9 challenge-front-managed test 2: "challengeOptions is not defined"). My r8 hunk took e4f's copy of the signature line inside the ownerSignatureReader hunk |
| test/attested-route-composition.test.mjs | the verifier-mode line adapted (INTENTIONAL API CHANGE marker; both versions must pass) and extended | an unknown mode is refused; the verifier mode with host services is refused; no host services → null. All mixed/paid/root/policy assertions are unchanged |
| stack-tests/stack-provider-authority.test.mjs (stage) | the chainVerifier regex follows route's wording; new test: local-verifier provider + host services → "never mixed", no request | meaningful guard on the fix |

**Static checks:** 21 bundle imports, 0 broken; no link beyond the head baseline; the edited JS parses.

**Lost-line audit:** every file touched in r8–r10, r7 lines versus r10. The other entries are only the intended union replacements (the TX_RPCS path, the descriptor callers, route's host-onchain replaced by the owner CLI) and shared-base lines that e4f/b6ac superseded. No further route-unique code loss was found. A filter restricted to route-unique lines only (r7 minus aebf) was not run; that is a follow-up.

## The six root-triage corrections (r9-root-build-triage.txt)
1. **Bounded symlink resolution** (`tools/manifest-staleness.py`). Git symlinks are resolved inside the tree, as the builders' readFileSync does: at most 8 hops, relative targets only. **An absolute, escaping, dangling or looping link is a failure.** The cases root measured (net-guard.mjs 16→9847 B, vbs-runtime.mjs, shield-derive.mjs) are now judged by their content.
2. **Sidecar mapping.** `runtimeFiles`/`sidecars` are {image destination: {source, sha256}}. The destination is never looked up in the tree; **the source must exist and hash to sha256**, and a record without a source fails. Nothing is blanket-excluded. **Fixture tests** (`tools/test_manifest_staleness.py`: resolved vs link-text, abs/escape/loop, image→source, wrong sha, missing source) run in the precheck before the auditor is trusted.
3. **Exact generated paths.** GENERATED.txt adds the generator's actual **public-rpc.{mjs,package.json}** and **service-tls.{mjs,package.json}**, plus the custody vendor pair, 26 paths in total. After regeneration, every listed path must exist, and **the generator's package directory must equal the listed package entries exactly**. The unrelated-change refusal is kept.
4. **Custody vendor.** `build-custody-vendor` moves from check-only into the regeneration sequence: **two passes, byte-identical**, then `--check`. Its sources are the composed custody modules, and its own manifest records esbuild and its dependencies.
5. **Checked git staging.** `stage_exact` stages exactly the regenerated paths (each must be in GENERATED.txt) through `--pathspec-from-file`. **Any git-add stderr fails**, the staged set must equal the regenerated set, and **no node_modules path may be staged**. It is used in both passes and for the final commit; the earlier `git add -A` is gone.
6. **Cancelled counts.** A Node run is clean only with a complete TAP summary (tests/pass/fail/cancelled/skipped/todo) and **cancelled 0**. Python treats **expected failures / unexpected successes** as failures. A run with no summary is unclean (dry run: cancelled=1 → unclean; expected failures=1 → unclean; garbage → unclean; the real r9 log parses).

**Kept:** every r9 gate (native inputs with no skip, deps identity, dependency graph and order (recomputed; no cycle), link gates, regressions, INTENTIONAL-CHANGES markers, tri-state). Nothing is waived. The r9 baseline-not-clean tests (dns-relay smoke, native-relay 1 fail, storage-front-binding 5 fails, lease-relay-host-policy 3 skips) stay INCOMPLETE.

## r9 actual outcome (root-composition-r9-0237)
- **Exit:** `.rc` = **130** (interrupted during E2 regressions; 6 regression files had run).
- **Real failures:** the four triage items above, plus the **2 regressions** fixed in r10. No other regression appeared before the interruption.
- **Not reached:** about 98 of the 104 regressions, the stack tests, the native overlay tests and phase G. **These remain unknown, and r10 is their first full run.**

## Root command (shared queue 2560, offline)
    ./jobs/q-exit-status.sh rpc-runtime-composition-r10-1 2560 unshare -rn bash rpc-runtime-composition-stage/r10/jobs/r10-build-validate.sh [--precheck-only]

## Remaining (exact)
- **Not executed:** the r10 code (the provider host-services refusal, the restored parameter, the new stack assertion, the auditor and its fixture tests, the staging and summary logic).
- **MCP:** the standalone MCP is kept separate and not composed (its r2 has no root PASS).
