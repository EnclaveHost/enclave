# mdbx-recovery-validator-stage/r3 (r2 + root 1672/1676 fixture sync fix + cancellation): official read-only libmdbx v0.13.12 `mdbx_chk` for the recovered Base holder DB. PREPARED; nothing built or run by Claude

Reports: `logs/claude-mdbx-validator-1661.md` (identification, limits), `logs/claude-mdbx-validator-fix-1667.md` (r2 runner), `logs/claude-mdbx-validator-r3-1677.md` (r3).

- **`pins/libmdbx-v0.13.12-f619d43d.sha256`** (= r1): all 33 files of the official amalgamated libmdbx dist vendored by reth `7134be3` (`base/reth` tag `base-v2.5.2.8`). That is the libmdbx the production `base v1.5.1` binary (sha256 `9c44836d…`) embeds; its build string is `v0.13.12-0-gf619d43d`.
- **`src/mk_fixture.c`** = root's `mdbx-fixture-repair-stage/r1/mk_fixture.c` (sha256 `b7119d1a…`, root 1676: r1's 10 tests PASS). The only change from r1: `mdbx_env_sync_ex(env, true, false)` accepts `MDBX_SUCCESS` **or** `MDBX_RESULT_TRUE` (-1, "nothing to flush", pinned `mdbx.h` 2946-2948). Every other call stays under the strict generic `CK` (only `MDBX_SUCCESS`).
- **`jobs/reuse-and-test.sh`** (root; queue **512**, `unshare -Urnm`): **no libmdbx recompilation**.
  - Reuses root's official build 1670 (`r1/runs/run-20261026T205843Z-2342321/build`) only if its `mdbx_chk` sha256 is `c228b462…`, `mdbx-static.o` is `14446d9c…`, its build flags (`config-gnumake.h`, `@buildflags.tag`) match, and its source copy matches the 33 pins;
  - copies those into the run (never writes to the reused directory) and compiles only `mk_fixture.c` against the copied object;
  - requires `mdbx_chk -V` rc 0 with the exact describe;
  - runs `tests/test_mdbx_validator.py` (**20** = r1's 10 + r2's 8 runner regressions + 2 cancellation tests) with `-W always::ResourceWarning` and fails on any ResourceWarning.
- **`src/mdbx_check.py`:**
  - requires the pinned `mdbx_chk` sha256 and version (`-V` rc 0 and the exact describe), `--timeout` 1..604800, a real `db/` directory with `mdbx.dat`, and a **read-only mount** (`ST_RDONLY`);
  - runs only `mdbx_chk -v [-0|-1|-2] DIR`: default read-only, exclusive, validation, full B-tree and key/value traversal;
  - r2 runner: own process group, one absolute deadline, non-blocking `selectors` reads, `waitid(WNOWAIT)` exit detection, SIGKILL of the group on deadline / output cap / stdout held after exit, always before the single bounded reap; an escaped holder is reported, never waited for;
  - **r3 cancellation:** `main` turns SIGTERM/SIGHUP/SIGINT into a `Cancelled` exception. While a child is owned (all of `bounded_run`) and while a report is written, the signal is only recorded; `bounded_run` polls it (≤ 0.1 s), SIGKILLs its group, reaps, and only then raises it. Exit **128+N**, `CANCELLED` on stderr, no report started after the signal; a report already being written is completed first. Previous handlers are restored on return;
  - checks the directory's identity is unchanged afterwards and writes a create-exclusive report. Only rc 0 is "structurally clean".

**Production use (root, after review; only on the disposable READ-ONLY overlay/view of `db/`):**
```
python3 -I -B mdbx-recovery-validator-stage/r3/src/mdbx_check.py --chk <reviewed mdbx_chk, sha256 c228b462…> --chk-sha256 c228b462c3c71c87b0fd2e9cfa6b3e6bccb2d793dd545bc6a18bef7113187981 \
  --db-dir <read-only view>/db --out <new report.json>
```
(r2's README pointed this command at `r1/src/mdbx_check.py`, the r1 wrapper with the blocking reader; use r3.)
**Expected cost:** one read of about 1.13 TB of used pages; a ~556 MB `pagemap` (int16 × 277,872,640 pages); an mmap whose page cache is reclaimable.

**Not chain verification:** there are no MDBX page or meta checksums (`validator_id = 0`; the steady sign is the constant `~0`). See the reports for the required further checks.

**Production gate wording:**
- **Plain-vs-hashed state consistency** must be a **FULL** read-only check, or the result must carry an **explicit "plain state UNVERIFIED" limitation**.
- **A sample cannot qualify full integrity.** It can only find problems, never clear them.
- The same applies to every other integrity step: a partial check is reported as partial, never as clean.


Root r4 changes only the fixture process-exit observer to treat ESRCH during a /proc stat read as gone, matching the actual r2 fixture failure1681. Checker runtime and assertions are unchanged from r3. Run jobs/reuse-and-test.sh in r4.
