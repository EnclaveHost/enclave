# base-reanchor-recovery-stage/r6 (PREPARED; source only; NOT run by Claude)

**Base: r5**, frozen and untouched (`MANIFEST.sha256` sha256 `92eb23a1013f7b395b65224cacae0e3e4da97cc7ad06473ff0c6ca876e415e0d`). Root's actual run is `logs/root-reanchor-r5-0305.out`, rc 1:
- the 95 regression tests were reused from r4 (`root-reanchor-r4-0302`);
- the new 19 ran: 17 PASS, **2 FAIL**. Both failures are
  `file_set: unexpected or missing files: ['code/__pycache__/l1_authority.cpython-314.pyc']`, in
  `test_capture_refusals_hold_replay_wrong_initial_tamper_pin_stale_ledger` and
  `test_newer_anchor_recovers_through_real_initial_and_recheck_captures`.

r4 is frozen as well.

**Cause:** this is a capture-module defect, not a fixture defect. The fix is in `a1-capture-binding-stage/r4`, which is r3 (root PASS 45) plus the verified-bytes l1-authority loader. Details are in `logs/claude-capture-import-safety-result.md`. The reanchor fixture is **not** changed to suppress bytecode.

## Changes vs r5 (exactly 3 product/test lines + docs; `r5-to-r6.patch`, 12 changed lines incl. comments)
| File | Change |
|---|---|
| `harness/a2a4.py` | `A1_CAPTURE_SHA256` `2352df7b…` (capture/r2) → **`db81ea49a2c241ee16ea0018e11dcedccadeb8bb678f51e68394470185639d20`** (capture/r4 `src/a1_capture.py`); two comments/messages r2 → r4. `A1_CAPTURE_REVIEWED = False` (HOLD) is unchanged. |
| `producer/base_launch.py` | `RECOVERY_A2A4_SHA256` `c4089a02…` → **`5e2658f7ec51dd12fb38a9d5eadcd2015f712182cb98486ac90772ace4e632da`**, the new harness. This is required because the producer pins the harness bytes. |
| `tests/test_reanchor_recovery.py` | `CAP_STAGE` → `a1-capture-binding-stage/r4`; the pin-assertion message says r4. The tests themselves are unchanged: 19 tests, no skip, real captures. |
| `harness-vs-reviewed.patch` | Regenerated the same way as r5's, against `base/a2a4.orig.py` (r5's file reproduces byte-for-byte with that method). |
| `inputs/consumed-inputs.sha256` | capture/r2 `SHA256SUMS`/`src`/`a1gate` → the capture/r4 equivalents, plus capture/r4 `R4-CHANGES.md`, capture/r3 `SHA256SUMS`, root's `root-a1-capture-r3-0306.out`, `root-reanchor-r5-0305.out`, `root-reanchor-r4-0302.out` and r5 `MANIFEST.sha256`. r2's `R2-CHANGES.md` and the r2 result log remain as documentation inputs. |
| `jobs/root-reanchor-r6-tests.sh` | New runner (r5's is not copied). |

Unchanged byte-for-byte from r5: `wrapper/*`, `tests/test_r3_launcher.py`, `tests/capture-stubs/*`, `harness/selection.py`, and `base/*`.

## Regression provenance: NOTHING is reused
The harness and producer bytes changed, and the r3 regression runs this stage's producer, which pins the harness. So r5's reuse of the r4 95 (justified by `cmp` with r4) **no longer holds**. The r6 runner runs the **full integrated suite fresh**:

| Suite | Tests |
|---|---|
| baseline-existing | 34 |
| recovery-existing | 34 |
| r3-regression | 27 |
| reanchor-recovery | 19 |
| **Total** | **114** |

Before anything runs, the runner verifies:
- the stage manifest, the consumed inputs, and capture/r4 `SHA256SUMS`;
- **the harness pin equals sha256(capture/r4 source)**;
- **the producer pin equals sha256(this stage's harness)**;
- the HOLD flags: `A1_CAPTURE_REVIEWED`, plus the two launcher-r3 flags, are False;
- `PYTHONDONTWRITEBYTECODE` and `PYTHONPYCACHEPREFIX` are unset.

The reanchor suite runs as an ordinary caller (`python3 -E -s`, no `-B`), which is exactly r5's failing condition. Any `code/__pycache__` in its output fails the run. The stage and capture/r4 must be unchanged afterwards.

**Holds:** Custody v2 stays REFUSED; lease consumers stay on HOLD; A1 capture stays on HOLD (`A1_CAPTURE_REVIEWED = False`). No source hold is flipped. No mainnet proof is claimed. The capture tests use STUB sources only.
