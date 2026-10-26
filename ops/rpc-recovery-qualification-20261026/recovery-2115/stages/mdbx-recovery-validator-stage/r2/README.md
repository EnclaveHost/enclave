# mdbx-recovery-validator-stage/r2 (r1 + root review: bounded runner, -V rc, timeout > 0): official read-only libmdbx v0.13.12 `mdbx_chk` for the recovered Base holder DB. PREPARED; nothing built or run

Report: `logs/claude-mdbx-validator-1661.md`.

- **`pins/libmdbx-v0.13.12-f619d43d.sha256`:** all 33 files of the official amalgamated libmdbx dist vendored by reth `7134be3` (`base/reth` tag `base-v2.5.2.8`). That is the libmdbx the production `base v1.5.1` binary (sha256 `9c44836d…`) embeds; its build string is `v0.13.12-0-gf619d43d`.
- **`jobs/build-and-test.sh`** (root; queue 2048, `unshare -Urnm`):
  - verifies the dist against the pins, copies it, and builds `mdbx_chk`/`mdbx_stat`/`mdbx_dump` with the official GNUmakefile recipe plus reth's `mdbx-sys` defines;
  - builds the fixture builder `src/mk_fixture.c` against the same `mdbx-static.o`;
  - checks `mdbx_chk -V`;
  - runs `tests/test_mdbx_validator.py` (18 = r1's 10 + 8 real-process runner regressions) through real read-only bind mounts;
  - keeps the binaries and their sha256 in `runs/<run>/build`.
- **`src/mdbx_check.py`:**
  - requires the pinned `mdbx_chk` sha256 and version, a real `db/` directory with `mdbx.dat`, and a **read-only mount** (`ST_RDONLY`);
  - runs only `mdbx_chk -v [-0|-1|-2] DIR`: default read-only, exclusive, validation, full B-tree and key/value traversal;
  - r2: runs every child in its OWN process group with ONE absolute deadline and non-blocking `selectors` reads; SIGKILLs the group on the deadline, on output beyond the cap, or when stdout is still held after the child's exit; detects exit with `waitid(WNOWAIT)` so the group is only signalled while the leader is unreaped; always reaps; reports an escaped holder instead of waiting for it;
  - requires `-V` rc 0 AND the exact describe string, and `--timeout` 1..604800;
  - checks the directory's identity is unchanged afterwards;
  - writes a create-exclusive report. Only rc 0 is "structurally clean".

**Production use (root, after review; only on the disposable READ-ONLY overlay/view of `db/`):**
```
python3 -I -B mdbx-recovery-validator-stage/r1/src/mdbx_check.py --chk <runs/<run>/build/mdbx_chk> --chk-sha256 <its sha256> \
  --db-dir <read-only view>/db --out <new report.json>
```
**Expected cost:** one read of about 1.13 TB of used pages; a ~556 MB `pagemap` (int16 × 277,872,640 pages); an mmap whose page cache is reclaimable.

**Not chain verification:** there are no MDBX page or meta checksums (`validator_id = 0`; the steady sign is the constant `~0`). See the report for the required further checks.

**Production gate wording (r2 correction of the r1 report):**
- **Plain-vs-hashed state consistency** must be a **FULL** read-only check, or the result must carry an **explicit "plain state UNVERIFIED" limitation**.
- **A sample cannot qualify full integrity.** It can only find problems, never clear them.
- The same applies to every other integrity step: a partial check is reported as partial, never as clean.
