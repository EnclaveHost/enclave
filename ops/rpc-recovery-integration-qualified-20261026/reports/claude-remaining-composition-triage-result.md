# Remaining r12 composition triage: result (PREPARED; nothing run; no PASS claimed)

**Inputs (read only):**
- the active r12 run `rpc-runtime-composition-stage/r12/run/r4-20261026T031250Z`: `RESULTS.tsv` (82 rows when read; the job is still in E2, with no rc file) and its receipt logs;
- the candidate `debbfb377d90f4193ea9182f5cb67d714ffaa322`, read through git objects only with `--no-optional-locks`;
- r12's `SHA256SUMS`, which still verifies.

**What Claude did:** no tests, builds, queue jobs, network or SSH access, live actions or commits. The enrollment fix (queued as 82988) was not touched.

**Stage:** `remaining-composition-triage-stage/` (`SHA256SUMS` sha256 `3e2c9dfb6978344ff11331d45561015bab968ed469476a756809ea0843de3b86`).

| File | sha256 |
|---|---|
| `patches/windows-lease-runtime-fixture-exports.patch` | `34988b0a3139c54b394f7f7a074cf168c6c5bd54adba9e10e2aded69e1cebbee` |
| `jobs/root-lease-fixture-fix.sh` | `644e3b88d46036510b4825f682319a0001443b77eac454b2d9b9d1bb70c4ae6e` |

## Every non-ok r12 row, classified from its actual receipt

| r12 row (final unless noted) | Receipt cause | Class | Covered by |
|---|---|---|---|
| host-service-transport 11/3 | `ReferenceError: rpcs is not defined` (`network-enroll.mjs:238`) | product composition regression | enrollment-composition-fix-stage (queued 82988) |
| host-services-cold-start 10/2 (route 12/0) | the same `rpcs is not defined` | product composition regression | the same enrollment fix (its expected 12/12 row) |
| attested-chain-verifier 14/1 (component 15/0), test 13 "G5" | the test expects `/chainVerifier \(a local verifier\)/`; `network/wg-provider/attested-authority.mjs:90` says `chainVerifier is not used with chainAuthority "attested-verifier" (a local verifier is …)` | composition message mismatch, final only | provider-verifier-composition-review-stage/r2 (`patch/g5-exact-cause.patch`) |
| lease-relay-host-policy 0/9 (both trees) | ENOENT `contracts/foundry/out/EnclaveDeployments.multicallValue.t.sol/MockFeed.json` (`cli-independent-rig.mjs:129`) | missing fixture artifact | rig-artifact-closure-stage (`root-r12-impacted-rerun.sh`) |
| cli-combined-independent 0/4, cli-independent-sessions 0/13 (both trees) | the same MockFeed ENOENT | missing fixture artifact | rig-artifact-closure-stage |
| offchain-heartbeat-writers **2 fail** (both trees) | the same MockFeed ENOENT (in that stage's map, `final-tests.txt`) | missing fixture artifact | rig-artifact-closure-stage |
| offchain-heartbeat-writers **1 skip**, test 2 ("negative control: the base supervisor DOES heartbeat") | `OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR` unset (test line 25, skip at :86) | **missing required integration input** (runner) | **NOT covered.** Action below |
| metal-control-overlay **2 skips** (both trees; `OK (skipped=2)`) | `CHAIN_VERIFIER_INPUTS not set` in E2 for `ChainVerifierOverlay.test_with_inputs_…` / `test_a_native_file_…` | runner phase gap, not a product defect | **r12's own F2** runs exactly this file with `CHAIN_VERIFIER_INPUTS=$CVI` (`r12-build-validate.sh:101, :264`). Action below |
| lease-designated-relays 0/5, lease-host-relay 0/3, lease-pinned-relay 2/2, lease-relay-migration 2/6 (**ownercli baseline identical**) | `The requested module './lease-gas-runtime.bundle.mjs' does not provide an export named 'chainAuthorityFromEnv'` | **stale TEST adapter** (baseline defect since `aebf4c932`) | **NOT covered. Patched here** |

**No other final-only regression** exists among the 82 rows read. The rows still to come in E2/F/F2 are unknown until the job ends.

## The one uncovered root cause, fixed here (test-only)

**The adapter:** `test/helpers/windows-lease-runtime-fixture.mjs` (blob `2218d397e`, identical on every head; last changed by `aebf4c932`) is redirected in place of `windows/node/lease-gas-runtime.bundle.mjs` by `registerHooks` in 7 tests. It re-exports 4 names.

**The importer:** `windows/node/chain.mjs:36` (candidate blob `3d0311e4…`) imports 6 names: `leaseGasConfigured, loadLeaseGasConfig, configuredLeaseSender, openReleaseJournal, chainAuthorityFromEnv, refusingChainAuthority`. The real bundle does export them (`Pl as chainAuthorityFromEnv`, `Bw as refusingChainAuthority`).

**The patch** (patched blob `fbdcfd28…`) adds two **pass-through** exports of the real functions. No product source changes and no gate changes; the adapter still only changes loopback/timeouts/clock.

**Affected test counts (static, no dynamic tests; anvil-gated, with anvil pinned):**

| Test | Tests |
|---|---|
| lease-designated-relays | 5 |
| lease-host-relay | 3 |
| lease-pinned-relay | 4 |
| lease-relay-migration | 8 |
| windows-current-runtime | 3 |
| windows-host-app-funded | 3 |
| windows-release-journal | 7 |

That is 33 tests in all. The last three use the same adapter and are not in r12's REGRESSIONS list.

**Root runner** (cap 2560):
```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/remaining-composition-triage-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $ST/logs/root-lease-fixture-fix.guard -- unshare -rn bash $ST/jobs/root-lease-fixture-fix.sh > $ST/logs/root-lease-fixture-fix.out 2>&1; echo $? > $ST/logs/root-lease-fixture-fix.rc
```

**What the runner does:**
1. **Pins:** the stage and r12 hashes; forge `4f77da08…` and anvil `10c1c727…`; the adapter, `chain.mjs` and all 7 test blobs.
2. **Exports and copies:**
   - a private `git archive` of the candidate;
   - the three dependency closures, with r12's `DEPS.txt` identity;
   - the bound contract artifacts, copied from r12's built `consumers` tree with r12's `copy-artifacts.py` and its manifest;
   - the network runtime, built.
3. **Patch:** it applies the patch and checks the patched blob.
4. **Tests:** it runs the 7 files with `TMPDIR` private and forge on PATH (the rigs' runtime forge builds).

**PASS:** each file rc 0 with tests = pass = the counts above, and 0 fail, skip, todo and cancelled.

**No unpatched rerun:** r12's own receipts are the unpatched evidence, reused.

**Risk:** `lease-relay-migration`'s second error ("the previous test left the source's unresolved send") is a cascade from the first import failure. If it persists after the fix, it is a separate defect. It is not assumed away.

## Exact next actions for the other two (no patch needed here)

1. **offchain-heartbeat-writers test 2 (negative control).** The base is the commit that added the test, `6f2c7da466dc26e5f7aac88c574a6b807e1a03df`. Its parent's `supervisor.js` (blob `3ad766906ea1dc34dc6b8010370b15ee7d47b6da`) has 27 heartbeat references, against 0 in the candidate.
   - In the rig-artifact-closure rerun tree (which must also supply MockFeed), run `git --git-dir=<candidate git> show 6f2c7da466dc26e5f7aac88c574a6b807e1a03df^:supervisor.js > <tree>/supervisor.base-6f2c7da46.js`, then set `OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR=<tree>/supervisor.base-6f2c7da46.js` for that one file.
   - **Expected:** 3/3 with 0 skips. The test requires "a file in the repository root".
   - That is a one-line runner addition for that stage's owner. I did not edit it.
2. **metal-control-overlay 2 skips.** Accept them **only** via r12's F2 `NATIVE` row (`native--metal-control-overlay.test.py.out`: rc 0, `OK`, no `skipped`) once it completes.
   - If F2 is clean, the E2 BASELINE-NOT-CLEAN row for this file is fully explained by phase design.
   - For r13: either pass `CHAIN_VERIFIER_INPUTS=$CVI` to this file in E2, or remove it from E2 because F2 covers it. Never treat a skip as a pass.

## Reuse; not repeated

- **Unchanged rows:** all r12 ok rows and receipts stay valid where their files are unchanged. None of the three patches (enrollment, G5, lease adapter) touches their files except as listed.
- **Recompose once:** after root's separate runs of the enrollment, G5, rig-artifact and lease-adapter fixes, build the composed r13 candidate with all four and re-run only rows whose files changed, plus the full suite once.

## Not established

- The job's later rows and F/F2 results.
- Whether the four fixes pass. None of them has run yet.
- The heartbeat and overlay actions depend on the rig stage and F2 outcomes.
