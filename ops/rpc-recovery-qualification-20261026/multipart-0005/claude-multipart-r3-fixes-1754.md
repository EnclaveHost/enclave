# recovery-multipart-stage/r3: narrow fixes after root's actual r2 runs and review 1750 (1754). Source + tests only

**Not done by me:** no test, build, copy or read of the original; no edit of r2, r9 or any other stage.
- **Read:** root's r2 actual stderr (`r2/runs/tests-20261026T234909Z-2488444` and `e2e-20261026T234936Z-2488952`), review 1750, and 1752.
- **Unchanged and verified:** r2 (SUMS `f8a75a7e…`); `status()` is byte-identical to r2's (`a88324f6`).

**Prepared tests are not an actual PASS.**

## Stage: `recovery-multipart-stage/r3`, FROZEN
**`SHA256SUMS` = `fcd8e0973597eebb7a003becca05f8695e770dd797a974f2bf7ce1beb041fe20`.**

| file | sha256 |
|---|---|
| `multipart.py` | `3159890b5bddcb763f578fa87b833931d695f4181dd447395bb40c2dff1c4381` |
| `orchestrate.py` | `a974b9e340f77d2dc048ab998c36f4c453b3f82d9a7279d48445619ed60837c1` |
| `tests/test_multipart.py` (31) | `9af3af38487548edff4eec7e7a31065c33caa660e8fa2594222be55121cbd26c` |
| `tests/test_e2e.py` (7) | `db9da880b4ab043afcfcdd46308bbdf09810be719fec1095516efd6d3f5be270` |
| `jobs/tests.sh` | `2a1e3effcc7792b18218603acedd553ca825beee942be6e7c2efb84aeeb5755e` |
| `jobs/e2e-tests.sh` | `5994faa4b6acf474aa8874dc417a6710ed82fc2f0c1ab6eeabbed037dc8e7021` |
| `jobs/root-preservation.sh` (gated) | `6d3c9f18b73a7d39ab7afd7c2b2fe1370ed19e254f551ad61999b93566d41cb0` |
| `README.md` | `a223962c5cbccfc75414cff008136f82c579e3090912c9431e4be209b20b9413` |

## Fixes
1. **The budget overshoot** (root unit: `stop=167936/184320` committed 40960/57344 instead of 36864/53248).
   - **Cause:** r2 read whole chunks, so a budget that fell mid-chunk overshot by up to one chunk.
   - **Fix (r3 `copy_part`):** each read is `n = min(chunk, remaining in part, budget − wrote)`, so the checkpoint lands exactly at the budget (sparse-extended if it falls in a hole).
   - **Budget 0:** `copy_run` raises `Cancelled("budget")` after admission and the pre-pass, **before** any source/session is opened. `--max-bytes < 0` is refused by both `multipart.py copy` and `orchestrate.py`.
   - **The boundary tests are unchanged.** New regression `test_max_bytes_is_honoured_exactly_and_zero_stops_before_reading`:
     - for 1, 4095, 8193, 40961 (1 byte into a hole), 65536 (exactly one part), 65537, and 2×65536 + 36869 (inside the tail hole): the durable bytes (committed part sizes + checkpoints, read from the files) == the budget, then resume == the source;
     - 0 leaves only the markers; −1 is refused (3); exactly L completes (0).
2. **E2E e3:** `assertIn(str, bytes)` → `o.decode()`. The expected rc 3 was already reached in root's run.
3. **1750 P1 (resumed-prefix provenance):**
   - **Order:** in the checkpoint-resume path, after the prefix hash check and **before** the `.partial` is truncated or extended, `revalidate_prefix()` re-reads `[0, committedBytes)` from the **current bound source** and compares it byte for byte with the partial (map holes must read zero).
   - **Re-checked every checkpoint interval:** `check_original`, `src.check()` (the session/server pidfd, the target identity, the mount), `tg.binding_ok`, and the memory floor.
   - **On a mismatch:** rc 4, nothing modified.
   - **On success:** an immutable `part-NNNN.resume-<run>.json` (committedBytes, prefixSha256, revalidatedBytes, the source binding) is written, and the whole part is then truthfully bound to the current session. **Full verify is still required.**
   - **Unit test:** the source changed inside the saved prefix gives rc 4 "differs from the CURRENT source"; the partial and checkpoint are byte-identical; no resume receipt. With the source restored, rc 0 and a resume receipt with `revalidatedBytes == committedBytes`, then verify passes.
   - **E2E e6** (the real killed r9 session) now also asserts: part 1's resume receipt has `revalidatedBytes == committedBytes ≥ 8192`, bound to the NEW session id, and part 1's commit record is bound to that new session.
4. **1750 P2-c (finalization):**
   - **`finalize(o, rc, out)`:** each of `end_session`, `confirm`, `record_session`, `prov.close` and `status` is attempted and caught. Errors go to `finalizationErrors`, and any error gives **rc 4**. The JSON is always printed.
   - **Write failures:** a failed (or partial) `record_session` makes the session `RECORD-WRITE-FAILED` (never CONFIRMED).
   - **`confirm`:** an unreadable, missing, extra or malformed receipt gives UNCONFIRMED with a reason.
   - **The main path:** any other exception gives rc 4 with JSON.
   - **Binding evidence:** `RUN/binding.json` is written right after the validated accept.
   - **Unit tests:** injected `end_session` TimeoutExpired plus a `record_session` failure gives rc 4, `RECORD-WRITE-FAILED`, both reasons, and close and status still ran. An injected `confirm` failure gives rc 4, UNCONFIRMED. Malformed, extra, wrong-field and missing receipts give UNCONFIRMED, no exception.
   - **Redemption:** the existing fresh-verify redemption (r2 `status`) still redeems UNCONFIRMED copies; there is no manual-confirm framework.
5. **1750 P2-b (the exec deadline):**
   - **The soft deadline:** session start (recorded at Popen) + `--exec-timeout` − `--deadline-margin` (default 3600 s; must satisfy 0 ≤ margin < timeout). It is checked before each part and at every checkpoint (copy) or interval (verify). It raises `Cancelled("soft deadline")`, then Q, a clean `serve` exit, session rc 0, CONFIRMED.
   - **Unit test:** a past deadline stops before any part file; a deadline passing after the 3rd read stops at the next checkpoint (32768); then resume completes.
   - **E2E e7:** `--exec-timeout 120 --deadline-margin 119` gives rc 5 "soft deadline", the session CONFIRMED, receipt rc 0 with `timedOut` false, `binding.json` present; then resume reaches the r9 model sha.
6. **1750 P2-d (claim precision):** docstring and README corrected. The session executes private re-hashed copies, and the orchestrator imports `multipart.py` from the frozen read-only stage. `root-preservation.sh` verifies the stage SUMS before starting Python. No loader framework.

**Not reimplemented:** 1752 (redeeming committed parts of an unclean session) is already in r2 `a88324f6`, and root's real e6 PASS confirms it. `status()` is unchanged.

## Root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh rmp-r3-tests 512 unshare -Urn bash recovery-multipart-stage/r3/jobs/tests.sh      # expect "## PASS (31)"
bash jobs/q-exit-status.sh rmp-r3-e2e 1024 bash recovery-multipart-stage/r3/jobs/e2e-tests.sh                 # expect "## PASS (7)"; FUSE, as owner
```
- **Production:** `jobs/root-preservation.sh` is unchanged in logic and requires PASSing r3 unit AND e2e receipts. It is still not authorized: there is no go-ahead for reading or copying the original.
- **Capacity:** per your measurement (root ≈ 575 GB, `/vm` 706 GB), the 120/145 split with 40 GiB floors each (plus your 8 GiB root native-build reserve) now fits admission's full-reservation check. It is re-measured at admission and every checkpoint.

## Residual (explicit)
- **E7 timing:** e7 assumes the r9 session set-up plus the start of the copy takes longer than 1 s after Popen. If the whole 12 MB fixture copy finished inside that second, e7 would fail loudly (rc 0 instead of 5), never pass falsely.
- **Resume cost:** prefix revalidation re-reads up to one part (≤ 4 GiB) per resumed part, in addition to the committed-part re-hash pre-pass.
- **Not faked:** fsync failure and real ENOSPC; write failure is covered via EFBIG. Production `--require-ro-mount` is covered by r9's own tests.
