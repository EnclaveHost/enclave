# A2/A4 bytecode gate bound to the actual receipt-v2 release: unit tests PASSED (r2-2336); all 47 controls PASSED (2336); NO real DB scan

| Item | State |
|---|---|
| Unit tests (root `root-a2-v2-bound-unit-r2-2336`) | **PASS.** Python **42 + 2 + 1** (`Ran 42 tests … OK`, `Ran 2 … OK`, `Ran 1 … OK`), Node **8** (0 fail/skipped/todo), `RUN-TESTS rc=0`, rc 0, `[queue] EXIT 0`, guard `exit=0 peakTreeRssMiB=107 minHostAvailableMiB=22334`. `inputs.check` verified 31/31 against the stage `SHA256SUMS` (`40243317…`). Evidence: `evidence/unit-r2-2336/` (receipts + every `logs/run-r2` file) and the coordinator `evidence/jobs/root-a2-v2-bound-validated-2336.sh` + `q-exit-status.sh`. |
| Earlier unit run 2330 | **FAILED 1** (test fixture: the test replaced the bound A1 receipt, and release correctly refused with `a1_binding`). Kept in `evidence/root-a2-v2-bound-unit-2330.*`. Repaired in the test only; the product `a2a4.py` `abe223d6…` is unchanged. |
| 47 negative controls (root `root-a2-v2-bound-mutants-2336`) | **PASS.** `MUTANTS rc=0`, rc 0, `[queue] EXIT 0`, guard `exit=0 peakTreeRssMiB=141 minHostAvailableMiB=22216`; root coordinator finished 0. All **47** expected names (33 inherited + 14 new v2) were killed, each exactly once, with a `killed` verdict JSON (0 errors/skips). The baselines are clean (Python 42 + 2 + 1, Node 8), preflight 47 OK, and inputs 31/31 against the stage `SHA256SUMS` `40243317…`. Evidence: `evidence/mutants-2336/` (receipts + all 111 log/tap/verdict/rc/input-check files of `logs/mutants/20261025T233849Z-181101`; no mutated trees, caches or binaries). |
| Source pin | `BYTECODE_CHECKER_V2_SHA256 = b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7`: root's actual release `root-bytecode-v2-release-2303`. Its source passed 23/23 native tests + 17 exact controls (`root-bytecode-v2-recovery-2259`), and it passed the Ubuntu ABI launch/refusal smoke (`root-bytecode-v2-abi-2318`, rc 0). |
| Gap | **NOT closed.** Pinning closes nothing; **no real database has been scanned.** Closure requires a real read-only scan at N of the stopped datadir with exactly this binary, bound to that DB, plus every other release gate, under root review. |
| Base | Frozen `a2-bytecode-integration` (its root results: 40 + 2 + 1 Python + 8 Node tests, 33 inherited controls). Only `a2a4.py` (the pin and its comment), `test/test_a2a4.py`, `mutants.sh` and the docs changed (`stage/diff-vs-a2-bytecode-integration.diff`). |
| New controls | 14 exact assertion-only controls for the v2 rules: table counts, accounts with code, checkpoints, datadir, checker rc, journal order and binding, download-receipt binding, stored receipt, source pin, v1 closure, pin None/other. They are part of the 47 above: **all killed (PASS)**. |
| Digests | **Framed keccak-256** (definition in `stage/NATIVE-V2-PROPOSAL.md`; the superseded sha256 proposal text is struck through). |
| Security audit | `stage/SECURITY-AUDIT.md`, written before the changes: S1 to S8, with no weakening needed. S2 (the fixture reset the pin to `None`) is fixed. |

**Contents:** source and two modest fixtures only. There is no binary, cache, build or log.
- `stage/` is a byte-identical copy of `finality-stage/a2-v2-release-bound` (31 files, verified against its `SHA256SUMS`).
- The original publications are unchanged.

**Evidence:** `evidence/EVIDENCE-INDEX.md` lists every result with its parsed checks. Source sha256 values are in `evidence/EVIDENCE-SHA256.txt` (unit r2, run-r2, coordinator, 2330, stage `SHA256SUMS`; its mutant line is a snapshot taken while the controls were still running, superseded by the PASS above) and `evidence/CONTROLS-SHA256.txt` (the mutant receipts and all 111 control-run files).

**Meaning:** the source-pinned integration (`BYTECODE_CHECKER_V2_SHA256 = b55e6b78…`) is tested: unit tests and every negative control pass. **That is not a closure of the bytecode gap.** No real database has been scanned. Production closure still requires the real read-only scan of the stopped datadir at N with exactly `b55e6b78`, after the final-134 download receipt and the real A2→A3→A4, bound to that DB, plus every release gate, under root review.
