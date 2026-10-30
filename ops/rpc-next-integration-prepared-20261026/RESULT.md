# rpc-next-integration-prepared-20261026 — RESULT

**Status: PREPARED.** Two root jobs that cover this material were **pending or running** when it was preserved (see below). Nothing here has been run by Claude.
**Not claimed:** the r4 52-test run, the r6 114-test run and the r12 full suite are NOT reported as passed. No commits or pushes were made.

## Contents (UTF-8 text only, each file < 2 MiB)
| Directory | Source (frozen) | Inner manifest (verifies in place) |
|---|---|---|
| `a1-capture-binding-stage-r4/` | `a1-capture-binding-stage/r4`: r3 plus the verified-bytes l1 loader and 7 import-safety tests | `SHA256SUMS` `ca8e5b15…3484` |
| `base-reanchor-recovery-stage-r6/` | `base-reanchor-recovery-stage/r6`: capture pin → r4, producer harness pin → `5e2658f7…32da` | `MANIFEST.sha256` `9cde2dcf…c642` |
| `rpc-runtime-composition-stage-r12/` | r12 metadata, tools, stack tests and runner `jobs/r12-build-validate.sh` | `SHA256SUMS` (r12's own) |
| `capture-import-safety/` | `r2-import-fix.patch` and `IMPORT-FIX.md` only | — |
| `reports/` | `claude-capture-import-safety-result.md`, `claude-reanchor-r6-result.md`, `claude-composition-r12-result.md` | — |
| `parent-qualification/` | root's **actual, completed** r3 qualification: `root-a1-capture-r3-0306.{out,rc,guard}` (rc 0) and its run's `py.txt`/`py.rc`/`node.version` (`Ran 45 tests`, `OK`) | — |

## Actual parent qualification (what IS passed)
- **capture r3: 45 tests PASS** (`root-a1-capture-r3-0306`, rc 0). Source `src/a1_capture.py` is `663038c89c9f3767eb441082700c0a08bc8aea7e48643b32c80bddff64c2a3ad`.
  - It includes `test_the_real_live_capture_record_fits_the_r3_limits_and_explains_r2s_refusal` and `test_the_real_pinned_gate_accepts_root_captured_receipts_and_refuses_a_tampered_one`.
- **Receipt references (not copied):**
  - `outputs/rpc-production-final-20261025/a1-capture-live-0252/root-result.json`, sha256 `5013566f…d606`: `captureOk: true`; verify refused because `capture.json` exceeded 1 MiB (r2 source `2352df7b…`); `productionActivated: false`. This is the refusal r3 fixes. It is **not** a fresh A1 qualification.
  - `logs/a1-capture-r2-root-receipt.out`, sha256 `34442bf4…eccc`.

## Root runners prepared, and pending actual jobs (outputs deliberately NOT copied)
| Runner | Root job (at preservation time) |
|---|---|
| `/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/a1-capture-binding-stage/r4/jobs/root-capture-tests.sh` (45 + 7, `python3 -I` with no `-B`) | `logs/root-a1-capture-r4-0313.out`: **RUNNING** (queue retry; 77 B, last write 2026-10-26T03:14:01Z) |
| `/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-runtime-composition-stage/r12/jobs/r12-build-validate.sh` | `logs/root-composition-r12-full-0313.out`: **RUNNING** (queue START; 15,529 B, last write 2026-10-26T03:14:00Z) |
| `/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r6/jobs/root-reanchor-r6-tests.sh` (full 114, fresh) | **not started**. Run it after capture r4 passes. |

## HOLD flags (all False; nothing is flipped)
- **`A1_CAPTURE_REVIEWED = False`** (r6 `harness/a2a4.py`). The capture module is not authorized to supply A1; the capture tests patch it to True only inside fixtures.
- **`FINALITY_PROOF_REVIEWED = False`** (r6 `producer/base_launch.py`; launcher r3). No authenticated-finality proof is reviewed, so launches stay on HOLD.
- **`LAUNCH_PRODUCER_REVIEWED = False`** (r6 `wrapper/chain_service.py`; launcher r3). The wrapper does not accept producer launches.
- **`FINALITY_PROTOTYPE_REVIEWED = False`** (`base-finality-proof-stage/src/finality_state.py`, not copied; the r4 runner checks it).
- **Other holds:**
  - Custody v2 stays REFUSED, and lease consumers stay on HOLD.
  - `productionActivated: false` in the live capture receipt.
  - No mainnet proof is claimed.

## Omitted (by rule) and inner references
- **Excluded:** `logs/`, `run/`, `tmp/`, `__pycache__`, binaries, `src.git` and clones; the currently running job outputs; r6's and r4's run directories; r12's `run/`; the capture-import-safety copy of the r2 tree. The two `node_modules` files allowed in are the r4 fakehash test fixtures (see Git note).
- **References to paths outside this directory:**
  - r12 `REFS.txt` names git refs (candidate `2d56a4b1…` = `refs/r11/candidate`) in **frozen r11's private `src.git`**, which is not copied.
  - r6 `inputs/consumed-inputs.sha256` and both runners use absolute work-tree paths (`/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/...`), so they verify only against the work tree.
- **Git note:** `.gitignore:4 node_modules/` ignores exactly two files, and root must add them with `git add -f`:
  - `a1-capture-binding-stage-r4/tests/stubs/deps/node_modules/fakehash/index.mjs`
  - `a1-capture-binding-stage-r4/tests/stubs/deps/node_modules/fakehash/package.json`

  No other file here is ignored. I checked with `git check-ignore`.

## Root correction and later evidence, 03:16 UTC
Capture r4 is QUEUED (not executing); r12 full is running. The r3 offline verification of unmodified live0252 capture PASSED at03:07: outputs/rpc-production-final-20261025/a1-live-verify-r3-0308/result.json, preserved in prior ops/rpc-capture-verified-20261026/live/verification.json. Original0252 root refusal remains historic, not the latest verdict.
MCP/r5 comparator actual23PASS plus semantic comparison EQUAL against existing real r4 artifact builds; no73MCPtestsran. Source/new23testsevidence preserved here. FullMCPwaiting complete rig artifacts: running compositionr12 exposed missing EnclaveDeployments.multicallValue.t.sol/MockFeed.json, all9lease-host-policy tests failed hook, not skipped. Worker preparing completeartifactclosure separately.
Compositionr12 has an additional setupaudit failure: known bound33contractfixturefiles appear individually in gitstatus butauditallowancedirectoryonly. Correction must validate exactpaths+bytes, not blanketignore. All remaining test outcomes unknown; no fullqualification claimed.
