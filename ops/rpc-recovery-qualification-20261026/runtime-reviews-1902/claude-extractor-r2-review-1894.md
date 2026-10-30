# 1894: independent SOURCE-ONLY review of compact-header-extraction-stage/r2 (report 1892, against review 1885)

**Scope of MY activity:** source reading only.
- **What I read:** `extract.py`, `jobs/coordination.py`, `jobs/root-extract.sh`, `jobs/e2e-tests.sh`, `tests/make_meta_fixture.py`, and the unit/e2e test lists plus e2e tests 7–8.
- **Not done:** edits, tests, queue jobs, builds, mounts, network, or any image/backup/part read.
- **Stage state:** r2 `SHA256SUMS` = `530757e8…` (`sha256sum -c` OK).
- **No r2 test has run.** Nothing here is a recovery, canonical-state, structural or reset acceptance.

## Concrete blocker (fix before production / before the state runner consumes `state-pins`)
**X1. A receipt-write failure can leave a COMPLETE "CLEAN" `EXTRACTION-RECEIPT.json` on disk while the run returns rc 4. `state-pins` then accepts it.**

**Where:**
- `write_json` (`extract.py:493-496`) creates the FINAL name with `O_EXCL`, writes the whole JSON, then `flush()` + `fsync()`.
- If `fsync` or the implicit `close` raises `OSError` (EIO, or delayed-allocation ENOSPC surfacing at fsync), `cmd_run` sets `written = False` and `final_rc` gives 4 (`:636-643`).
- **But the full receipt, with `"rc": 0, "outcome": "CLEAN"`, is already visible under the final name.**
- `state-pins` (`main`, `:695-707`) reads only that on-disk file, and `state_pins()` accepts it. It never sees the process rc.

**The consequence:** H1 ("never 0 without the receipt on disk") holds for the process exit code but not for the on-disk contract the state runner will use.

**Minimal fix:**
1. Write `EXTRACTION-RECEIPT.json.partial` (`O_EXCL`), fsync it, then `os.rename(..., dir_fd=run_fd)` to the final name, then fsync the run dir.
2. On any `OSError`, best-effort unlink the `.partial` and never create the final name.
3. Add a unit test with `os.fsync` patched to raise: the final name must be absent, the rc 4, and `state-pins` must refuse.

**What test 13 covers:** only the pure `final_rc`.

## Substantive fixes checked (source)
**B2: the fresh post-chmod binding. OK.**
- `backup_binding_errors` (`:360-379`) requires the pinned owner receipt bytes (sha `928d09ba…`, read with `O_NOFOLLOW`; a read over 64 KiB or a short read mismatches and refuses) recording exactly `"chmod0444 only"` on the pinned path.
- Both the receipt's `after` and the FRESH `lstat` must equal dev/ino/size/mode 0444/mtime_ns/ctime_ns. The pre-chmod ctime is never accepted.
- `source_identity` still refuses a writable backup.
- The binding runs before `qemu-img info` and before any run dir is created (`:545-556`).
- The post-run identity compare keeps r1's fields; ctime covers a mode change.

**B1: all 265 and an inactive driver, in both jobs, first. OK.**
- **Order:** both `root-extract.sh` and `e2e-tests.sh` run r9 `guards`, then the pinned `mount_identity.py` (`/vm` = UUID `aaae081c…`, cryptvm, ext4, 253:1), then `coordination.py`, all **before** any workspace, fixture build, mount or session. (`root-extract.sh` creates only its KB log dir under `runs/` first.)
- **`coordination.py`** refuses (rc 3) on:
  - `busy_reasons` of the pinned 1773 runner, plus any `root-multipart-batches-*` driver;
  - the root floor (remaining + max(40 GiB, manifest) + 8 GiB);
  - `completionFingerprint` None, i.e. the pinned r12 `live_completion` failing;
  - **any** remaining bytes.
- **No override exists.**
- **Point-in-time,** as stated (1885 M6); the main-lane exclusivity covers the window.

**H2/H3: OK** as described: the trap after the early checks, graceful stop, bounded `end_session` of only our child's group, hold 900 / exec-timeout 1200, and manual cleanup documented, never automatic.

**M2: the native lane. OK.**
- `lane_errors` requires `memory.max == 1024 MiB` and MemAvailable ≥ 16 GiB + 1024 + 256 MiB.
- It is enforced inside `cmd_run` for every run, production and fixture.
- Unit test 15's fixture-mode refusals happen in `main` before `cmd_run`, so they do not depend on the 256 test lane.
- **Minor (not a blocker):** `e2e-tests.sh` creates the `/vm` workspace before any lane check. In a wrong lane, each extraction refuses and the e2e fails closed, leaving an empty owned workspace.

**M3: OK.** `/vm` is checked by the pinned `mount_identity` in both jobs, and `extract.py` keeps its 253:1 check.

**M4: fixture/e2e safety. OK.**
- **In `main` (`:717-726`), fixture mode refuses:**
  - the production backup, by realpath or basename;
  - any dest not matching `…/tr004-base-recovery-20261026/compact-header-e2e-<UTC>-<pid>[/x[/y]]`;
  - lowered floors.
- **The e2e dests** (`$W/work/dest-N`) fit that pattern.
- **The e2e** runs only after coordination passes (all 265 complete, no driver, so the vm reservation is 0), with /vm free ≥ floor + 2 GiB and `timeout -k 10 3600`.
- **The post-run checks:** no surviving mount or process naming `$W`, peers unchanged, SUMS unchanged, exactly `Ran 8 tests` and OK.

**B3: the on-disk metadata fixture. OK as prepared; unverified until run.**
- **The builder:** `make_meta_fixture.py` uses the pinned r9 fixture helpers (sha-checked) to run `mkfs.ext4` + `debugfs -w` **on its own private raw file** in the new workspace. It self-checks every field with `debugfs stat`, converts to a 0444 qcow2, and deletes the raw.
- **Test 7** requires CLEAN with exact mode/uid/gid/mtime_ns (non-zero ns 98139981)/nlink/size/sha256, plus byte equality.
- **Test 8:** each single-field change (mtime_ns + 1, uid 0, gid 0, mode 0644) must REFUSE "differs from the allowlist" with `files/` empty. Every entry's metadata is checked before any copy.
- **Unverified until the actual run** (as 1892 states; each fails closed if wrong): whether `debugfs sif … mtime @s` / `mtime_extra` are accepted, and whether the fakeroot view reports on-disk uid/gid/ns mtime.

## `state_pins` → state runner mapping
**It is compatible with `state-production-validation-stage/r1`:**
- **The directory:** `staticFilesDir = <run>/files/data/static_files`, absolute and outside the state run dir.
- **The files:** `staticFiles` = 6 × `{name, size, sha256}`, plain names, in allowlist order. That is exactly the acceptance/state `PIN_SF_KEYS` shape.
- **The runner's re-hash:** its `static_identities` requires the dir to hold EXACTLY those six names and re-hashes them. A CLEAN run leaves no `.partial` there; `reth.toml` sits in `data/`, not in `static_files/`.
- **Pinning the receipt:** `extractionReceiptSha256` (computed by the CLI over the bytes it parsed) is what the state runner pins as `extraction`.

**Production-only by path:** the CLI requires `--run-dir` to start with `/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-`. Fixture runs live under `…/compact-header-e2e-…/`, so a fixture receipt cannot be mapped.

**Optional hardening (not a blocker):** also require in `state_pins`:
- `format == "compact-header-extraction-receipt/v1"`;
- `backupReceiptSha256 == BACKUP_RECEIPT[1]`;
- `sourcePre` equal to `sourcePost` on dev/ino/size/mtimeNs/ctimeNs.

These are implied by CLEAN today, but cheap to bind at the consumer.

**Wiring for state r1's BLOCKED `extractionReceipt`:**
- load this stage's `extract.py` pinned by sha;
- read the pinned `EXTRACTION-RECEIPT.json` bytes;
- call `state_pins(receipt, run_dir)`;
- require its `staticFilesDir`/`staticFiles` to equal `PRODUCTION_INPUTS` and the extraction pin sha to equal those bytes;
- also require this stage's actual unit (16) and e2e (8) PASS receipts.

**Only after X1 is fixed.**

## Verdict
**One concrete blocker:** X1, the non-atomic receipt write versus the `state-pins` contract.

Everything else reviewed (B1/B2/B3, H1–H3 apart from X1, M2–M4, the mapping) is addressed in source. Two items remain unverified until the actual unit (16) and e2e (8) runs. Production stays on HOLD per 1892.
