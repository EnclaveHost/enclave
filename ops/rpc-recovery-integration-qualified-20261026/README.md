# rpc-recovery-integration-qualified-20261026 (preservation for root review; nothing run by Claude)

**Base:** source/ops HEAD `1ecf6b67a` (pushed). **Production stays UNQUALIFIED.** Admin authority is intact; the queue memory floor is 16 GiB. Custody v2 stays REFUSED, and lease consumers and A1 capture (`A1_CAPTURE_REVIEWED = False`) stay on HOLD. No source or runtime changes were made.

## Qualified, from root's actual runs
- **Reanchor recovery, all 114 offline checks passing; production activation remains unqualified.**
  - **r6** (`evidence/reanchor/root-reanchor-r6-0336.*`, rc 1): baseline 34, recovery 34 and r3-regression 27 PASS. reanchor-recovery was 18/19, failing on a test-fixture record-ordering defect.
  - **r7** (`root-reanchor-r7-0345.*`, rc 0): **reanchor-recovery 19/19 PASS executed**, plus **95 reused** from the r6 evidence (`r6-suite-logs/`). The product is byte-identical to r6, which the runner `cmp`-checks. Queue cap 256 MiB; peaks were 215 MiB (r6) and 219 MiB (r7).
  - **Source:** `stages/base-reanchor-recovery-stage-r7` (MANIFEST `9b558d5b…c6cb`). The capture it pins is `a1-capture-binding-stage/r4` (`SHA256SUMS` `ca8e5b15…3484`; `evidence/capture-r4/root-a1-capture-r4-0313.*`, rc 0).
- **Enrollment fix** (`evidence/enrollment/`, `root-enrollment-fix-0333` rc 0):
  - **Patched: 76/76 PASS.**
  - **Unpatched negative control: 20 tests.** U-host-service-transport is 11/14 and U-regression is 2/6. These 7 failures show the defect without the fix. They are expected and are not product failures.
  - Files: `verdict.json` (`ok: true`) and per-suite TAP/rc logs.

## Evidence that is NOT a pass
- **Composition r12** (`evidence/r12/`, `root-composition-r12-full-0313` rc 1, **RESULT: FAIL**):
  - Included: the actual `RESULTS.tsv`, `receipts/RECEIPTS.tsv`, `RECEIPTS.sha256`, and the **41 failing receipts** (every pair that was not clean, each under 256 KiB). One failing receipt is not copied: key `01e6f112…` is missing or at least 256 KiB.
  - Inventory: 28 component rows, 104 regression rows, 9 stack rows and 1 native-input row; the runner summary labels the 133 non-stack rows as component tests. It reports 8 regressions and 16 baseline-not-clean rows.
- **Fixture audit 0347** (`evidence/audit-0347/`, rc 1): `audit.json` has `ok: false`, so the raw audit did NOT pass. `root-cache-assessment.json` is root-verified for the corrected D audit only. The only remaining finding is a `.pyc` whose source sha, timestamp and size match and whose code object matches the current compiler. That exact cache file is absent from both built images (image-a and image-b exist). `fullCompositionPass: false`.
- **Provider verifier r2** (`evidence/provider-r2/`, `root-provider-verifier-r2-0327` rc 1):
  - The negative `pre-attested-chain-verifier` run had 15 tests: 6 pass, 9 fail. The cause is that the run's `unshare` left loopback down. This is an environment setup failure and is **NOT** a product failure or a qualification.
  - The unchanged retry, job 14983 with loopback enabled, is still awaited.
- **Stack import fixture** (`evidence/stack-import/`, `root-stack-import-fixture-0349` rc 0): the original run fails (rc 1) and the patched run passes (rc 0), for the stack-windows-chain-reader import fixture only.

## Stages: source, tests, runners and manifests only (inner manifests verify in place)
| Directory | Inner manifest sha256 |
|---|---|
| `stages/base-reanchor-recovery-stage-r7` | `9b558d5b…c6cb` |
| `stages/remaining-composition-triage-stage` | `3e2c9dfb…3b86` |
| `stages/rig-artifact-closure-stage-r2` | `aaea7dfa…7c9a` |
| `stages/stack-import-fixture-stage` | `6a3e3d93…cc94` |

`reports/`: the Claude result reports for r6, r7, the triage, the rig closure and rerun r2, the stack import, the enrollment fix and the fixture audit.

## Omitted (deliberately)
- **Still pending, so their outputs are mutable and are not copied:**
  - `root-r12-impacted-rerun-r2-0346` (no rc; its run directory is still being written);
  - `root-lease-fixture-fix-0342`;
  - `root-mcp-authority-r6-0333`;
  - provider retry 14983.
- Root correction: the finished plan is at `final-source-composition-plan-stage-r2` (hyphenated), and is now included. It is a prepared plan, not executed source composition.
- **By rule:** clones, run trees (`trees/`, `original/`, `unpatched/`), images, binaries, `node_modules`, full forge `out/`, `objs-*.json` bytecode snapshots, the 3 MiB `final-tree.before.sha256`, and every non-UTF-8 file.
- **External references only:** r6/r12/r4 stages are cited by their manifests (r6 `9cde2dcf…c642`, r12 `00d9a98f…de22`, capture-r4 `ca8e5b15…3484`).
- **Secret scan:** no private keys or tokens were found. The 5 distinct 64-hex strings are hashes in the logs, and the public Anvil key does not appear.

## Root additions
The tested r4 capture verifier authenticated the unchanged live0252 initial capture offline: evidence/live-a1-r4, rc0. This re-verifies the loader change against actual evidence; it is not a new capture, chain refresh, SNP qualification or activation. Source cutover is user-authorized but remains technically unqualified; earlier plan wording suggesting missing user authorization is incorrect. The stack fixture has 3/3 patched passes and a 2/3 original negative control; no product source changed.
