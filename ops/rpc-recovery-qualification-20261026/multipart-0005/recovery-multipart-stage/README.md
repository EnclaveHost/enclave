# recovery-multipart-stage/r3: narrow fixes to frozen r2 (root's actual r2 runs, review 1750)
(PREPARED by Claude 1754, SOURCE + tests only; NOTHING run by Claude. Report: logs/claude-multipart-r3-fixes-1754.md)

**Status: PENDING.**
- **Tests:** not yet run (root runs `jobs/tests.sh` with 31 tests and `jobs/e2e-tests.sh` with 7). Prepared tests are not an actual PASS.
- **Production:** `jobs/root-preservation.sh` stays gated. There is no go-ahead for reading or copying the original, and it requires passing r3 receipts.
- **r2** (SUMS `f8a75a7e…`) is unchanged.
- **Never** a recovery, data-integrity, RAID-reset or production-ready statement.

## r3 changes (no new architecture)
1. **`--max-bytes` is honoured exactly** (root r2 unit run: the 2 sparse sub-failures overshot by a chunk).
   - Each read is capped by the remaining budget.
   - A budget of 0 stops before any source is opened; a negative budget is refused.
   - The boundary tests are unchanged; a new regression covers 1, 4095, 8193, 40961, one part, one part + 1, a tail-hole offset, 0, −1 and the whole size.
2. **A resumed prefix is re-proven** (review 1750 P1). Before a checkpointed `.partial` is touched, its whole saved prefix is RE-READ from the CURRENT bound source and compared byte for byte (map holes must be zero).
   - **Re-checked at every interval:** the original identity, the source provenance, the target binding and the memory floor.
   - **On a mismatch** the run fails and every file is kept.
   - **Then** an immutable `part-NNNN.resume-<run>.json` records it, so the commit's single binding is truthful.
   - **Full verify is still required.**
3. **Finalization** (1750 P2-c):
   - every step (session end, receipt confirmation, session records, provenance close, status) is caught and its reason recorded;
   - the JSON is always printed, and any finalization error gives rc 4;
   - a session whose records could not be written is `RECORD-WRITE-FAILED`, never CONFIRMED;
   - a malformed, extra or missing receipt gives UNCONFIRMED, never an exception;
   - the validated binding is saved to `RUN/binding.json` right after the accept.
4. **Soft deadline** (1750 P2-b): session start + `--exec-timeout` − `--deadline-margin` (default 3600 s). It stops copy/verify at a checkpoint or part boundary (rc 5), before r9's hard deadline, so the session ends rc 0 and is CONFIRMED.
5. **The e3 test fix:** the Popen output is bytes, so it is decoded before `assertIn` (the expected rc 3 was already reached).
6. **Claim precision** (1750 P2-d): the session executes private, re-hashed copies of the code, but `orchestrate.py` itself imports `multipart.py` from the stage dir. The stage is frozen read-only, the production job verifies the stage SUMS before Python starts, and the request binds both shas.

**Not reimplemented:** the 1752 committed-part redemption is already in r2's `a88324f6` (`status`: a fresh PASS in a CONFIRMED session redeems an UNCONFIRMED commit). Root's real e6 PASS confirms it.
