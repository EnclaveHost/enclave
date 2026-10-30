# Reanchor r6 — result (PREPARED; source only; NOTHING run by Claude)

**Stage:** `base-reanchor-recovery-stage/r6`, made from r5. r4 and r5 are frozen and verified unchanged.
**Root's r5 run:** `logs/root-reanchor-r5-0305.out`, rc 1: the 95 tests were reused from r4, and of the new 19, 17 passed and 2 failed with `file_set` `code/__pycache__/l1_authority.cpython-314.pyc`.
**The fix:** in capture r4, not in the fixture. See `logs/claude-capture-import-safety-result.md`.

## Changes vs r5 (`r6/r5-to-r6.patch`; details in `r6/R6-CHANGES.md`)
- **`harness/a2a4.py`:** `A1_CAPTURE_SHA256` → **`db81ea49…9d20`**, which is capture/r4 `src/a1_capture.py`. Two comments/messages now say r4 instead of r2. `A1_CAPTURE_REVIEWED = False` is unchanged (HOLD).
- **`producer/base_launch.py`:** `RECOVERY_A2A4_SHA256` → **`5e2658f7ec51dd12fb38a9d5eadcd2015f712182cb98486ac90772ace4e632da`**, the new harness. The producer pins the harness bytes, so this pin had to change.
- **`tests/test_reanchor_recovery.py`:** `CAP_STAGE` → capture r4, and the assertion message is updated. The 19 tests are otherwise unchanged; the real captures still run and none is skipped.
- **Unchanged from r5:** wrapper, `test_r3_launcher.py`, the capture stubs, `selection.py`, `base/*`.
- **Regenerated:** `harness-vs-reviewed.patch` (r5's reproduces byte-for-byte with the same method) and `inputs/consumed-inputs.sha256` (capture r4/r3 and root's r3/r4/r5 logs replace the r2 code entries).

## Provenance: full fresh suite, nothing reused
The harness and producer bytes changed, so r5's `cmp`-with-r4 reuse of the 95 is no longer valid. The r6 runner runs all **114** fresh:

| Suite | Tests |
|---|---|
| baseline-existing | 34 |
| recovery-existing | 34 |
| r3-regression | 27 |
| reanchor-recovery | 19 |

## Root runner (exact): `r6/jobs/root-reanchor-r6-tests.sh` (sha256 `e9047d81…024`)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-reanchor-recovery-stage/r6
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $S/logs/root-reanchor-r6-tests.guard -- unshare -rn bash $S/jobs/root-reanchor-r6-tests.sh > $S/logs/root-reanchor-r6-tests.out 2>&1; echo $? > $S/logs/root-reanchor-r6-tests.rc
```
- **Before anything runs** (exit 2 if any check fails):
  - `MANIFEST.sha256`, the consumed inputs, and capture r4 `SHA256SUMS` all verify;
  - harness pin == sha256(capture r4 source), and producer pin == sha256(harness);
  - the HOLD flags (`A1_CAPTURE_REVIEWED` and the two launcher-r3 flags) are False;
  - `PYTHONDONTWRITEBYTECODE`/`PYTHONPYCACHEPREFIX` are unset, as for r4–r5;
  - the drop-in marker and the existing-archive guard pass.
- **How the suites run:** `python3 -E -s` with no `-B`, which is r5's failing condition.
- **PASS requires:**
  - all four suites PASS (exact counts, final `OK`, no skips);
  - no `code/__pycache__` appears in the output;
  - the stage and capture r4 are unchanged afterwards.

## Manifest
- `r6/MANIFEST.sha256` sha256 **`9cde2dcf9fda3559cd207307adb22b8fb602fe90ea79c5928547c86a9355c642`** (25 files).
- `inputs/consumed-inputs.sha256`: 29 entries.

## Order
1. Root runs capture r4 (45 + 7).
2. Then reanchor r6 (114).

r6 consumes the r4 pin. NOT verified by running; PASS only if root's runs pass. Custody v2 stays REFUSED; lease consumers stay on HOLD; A1 capture stays on HOLD. No hold is flipped. No mainnet proof is claimed.
