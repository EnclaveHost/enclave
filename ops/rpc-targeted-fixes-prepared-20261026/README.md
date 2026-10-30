# rpc-targeted-fixes-prepared-20261026: README

**Status: SOURCE ONLY. Nothing here is deployed or activated, and nothing is fully qualified.**
- **What it is:** preserved copies of six completed, frozen prepare-only stages. It was staged for root to review and commit.
  Claude did not run git, stage or commit anything.
- **Not done:** no tests, builds, queue jobs, network or SSH access, and no live changes were made while preserving.
- **Copies only:** the source stages and the active jobs' inputs were not touched.
- **Holds unchanged:**
  - every activation and review flag stays False;
  - custody v2 stays REFUSED and lease consumers stay on HOLD;
  - the original `control-guest-cutover-stage` stays REJECTED and is not included.

## Contents
94 bounded UTF-8 text files (about 644 KB), each under 2 MiB, including this README and the outer `SHA256SUMS`. The outer
manifest lists the other 93 files, inner manifests included.

| Directory | Source (frozen) | Files | Inner manifest (verifies in place) |
|---|---|---|---|
| `enrollment-composition-fix-stage/` | `enrollment-composition-fix-stage/` | 5 | `SHA256SUMS` `96281e46…8c0cfa` |
| `rig-artifact-closure-stage/` | `rig-artifact-closure-stage/` | 23 | `SHA256SUMS` `bdc8ae2a…a78a0e` |
| `standalone-mcp-authority-stage-r6/` | `standalone-mcp-authority-stage/r6/` | 9 | `SHA256SUMS` `190f9ac9…e3ff0f` |
| `provider-verifier-composition-review-stage/` | same, **including root's `r2/`** (runner correction) | 11 | `MANIFEST.sha256` `5d194ff2…56f259`, `r2/MANIFEST.sha256` `3b96c5db…d21ee0` |
| `composition-fixture-audit-correction-stage/` | same, including root's `root-unit-0323/tests.out` | 6 | `SHA256SUMS` `91cade5b…05a212` |
| `control-guest-cutover-stage-r2/` | same | 17 | `SHA256SUMS` `0bca2cc7…343648` |
| `reports/` | the 5 `logs/claude-*-result.md` reports | 5 | — |
| `qualification/` | root's actual receipts (below) | 16 | — |

Every stage copy is byte-identical to its source. The only difference `diff -r` shows is an empty `logs/` dir in the enrollment
and fixture-audit stages, which was not copied.

## Actual root results (what IS passed, and its scope)
| Receipt dir | Job | Result | Scope |
|---|---|---|---|
| `qualification/capture-r4-0313/` | `root-a1-capture-r4-0313` (cap 256, peak 218 MiB, min 22051) | rc 0. **52 PASS:** `capture.txt` "Ran 45 tests … OK" and `import-safety.txt` "Ran 7 tests … OK" (no skips) | capture/r4 source tests only. Also holds the cap-change note `0328` and `node.version` |
| `qualification/fixture-audit-unit-0323/` | `root-fixture-audit-unit-0323` (peak 67 MiB) | rc 0, **13 PASS** ("Ran 13 tests") | auditor unit tests only. **The actual full-run audit of r12 is still pending** |
| `qualification/control-cutover-r2-0335/` | `root-control-cutover-r2-0335` (cap 256, peak 18 MiB, min 21636) | rc 0, **106 checks passed, 0 failed** | offline stub/fixture tests of the guards, HOLDs and rollback. **NOT a production cutover qualification** (see `COMMAND.txt`) |

## Pending: QUEUED / RUNNING / NOTRUN at preservation time (2026-10-26 ~03:36Z; outputs deliberately NOT copied)
| Item | State |
|---|---|
| composition r12 full (`root-composition-r12-full-0313`, exec 11999) | RUNNING (no rc) |
| provider-verifier r2 (`root-provider-verifier-r2-0327`, exec 92355) | QUEUED (not started) |
| reanchor r6 114 (`root-reanchor-r6-0336`, exec 86785) | RUNNING at cap256; prior queued71380 canceled before any test started |
| enrollment fix (`root-enrollment-fix-0333`, exec 82988) | QUEUED (not started) |
| MCP r6 73 + comparator 23 (`root-mcp-authority-r6-0333`, exec 68896) | QUEUED (not started) |
| rig impacted rerun (`rig-artifact-closure-stage/jobs/root-r12-impacted-rerun.sh`) | NOTRUN (runs after r12) |
| fixture-audit actual full-run audit/combine (`root-post-run-audit.sh`) | NOTRUN (runs after r12) |
| control cutover on the real guest | AUTHORIZED BY USER, NOT QUALIFIED FOR EXECUTION. The gates HOLD: no accepted release, no verifier or backend receipts, no canary protocol |

## Omitted (by rule)
- **Run and work directories:**
  - every `run/`, `scratch-*`, `out-*` and `tmp/` dir;
  - `a1-capture-binding-stage/r4/logs/root-capture-tests-*/run` and `tmp`;
  - the r12 run `rpc-runtime-composition-stage/r12/run/…`, which is active.
- **Code and builds:** cloned repos and git trees, the `node_modules`/dependency closures, binaries, forge `out/`/`cache/`
  artifacts, caches and `__pycache__`.
- **Logs:** the pending/active jobs' outputs, session transcripts and task files.
- **Other stages:** the frozen and rejected original `control-guest-cutover-stage/`, and the full HANDOFF (it lives at
  `outputs/rpc-production-final-20261025/HANDOFF.md`, 272 KB).
- **Empty paths:** the empty stage `logs/` dirs. `rig-artifact-closure-stage/map/raw-scan.err` is included; it is empty
  (0 bytes) and listed in that stage's manifest.

## Secret inspection
I grepped for PEM blocks, private-key, password and bearer assignments, GitHub, AWS and Slack tokens, mnemonics, and `0x`+64-hex
strings. **No credential values were found.**
- **Only hit:** `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` in
  `provider-verifier-composition-review-stage/{,r2/}work/{a,b}/test/attested-chain-verifier.test.mjs:263`. It is the publicly
  documented Anvil/Hardhat dev account #0 test key in upstream test source, not a credential.
- **Fake fixture values:** the cutover r2 tests use fake values (`s3cr3t-*`). The 0335 receipt contains none (0 matches).

## Verify
`sha256sum -c SHA256SUMS` from this dir (it covers every file except itself). Then run each inner manifest in its own dir.

Root correction: the preserved Claude reports retain their original wording. User authorization for eventual production cutover exists; missing technical qualification is the hold. Reanchor now runs in the small memory lane after confirmation that its earlier queue job had no test descendants. No test source changed.
