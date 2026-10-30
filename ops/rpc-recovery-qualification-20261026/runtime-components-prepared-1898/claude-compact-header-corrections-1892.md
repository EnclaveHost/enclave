# 1892: compact-header-extraction-stage/r2 = r1 + review 1885 corrections (SOURCE ONLY; nothing run; NOT PASS)

**What I did not do:** run any test, build, queue job, mount, network or install; access the original, the backup image or any part; commit; touch the state runner (`state-production-validation-stage`, owned by agent da).

**What I read:** the RAID owner's small receipt JSON (`tr004-compact-backup-readonly-receipt.json`, sha `928d09ba…`), source, and existing small evidence.

**Preserved:** r1 (SUMS `bd333afa…`) still verifies. Root's actual r1 unit tests passed 10; there was no e2e.

**Pure/test receipts are never acceptance.**

## Frozen stage
- **SHA256SUMS sha256:** `compact-header-extraction-stage/r2/` → **`530757e8bd2bb775ec82fd299b55bb4fe5bbbb52a25d00761317749a38af06fa`**
- **Contents:** 9 files, all a-w; no runs or bytecode.

| file | sha256 |
|---|---|
| `extract.py` | `7e1a39e4…` |
| `jobs/coordination.py` | `208c0825…` |
| `jobs/e2e-tests.sh` | `27894d03…` |
| `jobs/root-extract.sh` | `458225cf…` |
| `jobs/tests.sh` | `789aeba5…` |
| `tests/make_meta_fixture.py` | `faa9f920…` (new) |
| `tests/test_extract_e2e.py` | `4596f41c…` |
| `tests/test_extract_unit.py` | `8c40ec4a…` |
| `README.md` | `f9604daf…` |

**Unchanged and still pinned:** the r9 lifecycle (`overlay_session.py` `65d45ab7…`, SUMS `17b5528f…`) and the pinned `fuse2fs` (`6e3b5404…`). There is no new lifecycle, framework or kill path.

## Corrections (review 1885 → r2)
- **B2 (resolved by the owner), bound fresh:**
  - **The pin:** `BACKUP_RECEIPT` (path + sha `928d09ba…`), read with `O_NOFOLLOW`, ≤ 64 KiB.
  - **The check (`backup_binding_errors`):** the receipt records exactly `"chmod0444 only"` on the pinned path. Its `after` equals the pinned dev 64768, ino 4856848, size 120867323904, mode `0o444`, mtime_ns 1793046916167070631 and ctime_ns 1793097367170099837. **The backup's FRESH `lstat` must equal the same values.**
  - **What is never accepted:** the pre-chmod ctime (1793051528993087982); unit test 12 checks this. Any later metadata change (a new ctime) refuses until a new owner receipt is pinned.
  - **The pre/post identity comparison of r1 is kept.**
- **B1, ALL 265 and an inactive driver, for E2E AND production, no exception:**
  - **`coordination.py`** additionally calls the **pinned bsro r12 `bsro_gate.live_completion`** (sha `0641637a…`: the pinned 1773 runner + r3 core + manifest). Any failure or remaining bytes → refused "not all 265 parts committed and verified". The driver/batch/orchestrate/overlay/stage-mount refusals are unchanged.
  - **Order in BOTH `e2e-tests.sh` and `root-extract.sh`:** r9 `guards` → the pinned `mount_identity.py` → `coordination.py`, all **before** any fixture build, workspace, mount or session.
  - **There is no driver pause or override.**
- **H1:** `final_rc(rc, receipt_written)`. If `EXTRACTION-RECEIPT.json` cannot be written, the rc is 4, never 0 (and never "STOPPED-only"); it is printed to stderr and the summary is recomputed.
- **H2:** both jobs `trap ':' TERM INT HUP` after the early checks. A TERM reaches `extract.py`, which does its graceful stop (RELEASE, then the bounded `end_session` of only our unreaped child's group). The wrapper then still takes peers-after, SUMS and the mount/process checks, and prints its rc. Nothing new kills anything.
- **H3:** `HOLD_DEFAULT = 900` (r9 `--exec-timeout` = 1200). The README documents an **ownership-checked manual cleanup** after hard kills: only PIDs whose cmdline names THIS run's `session/work` and whose Uid is ours, TERM then KILL; `fusermount3 -u` only at `RUN/session/work/{mnt,view}`; remove only the overlay; keep the evidence. It is never automatic.
- **M2:** `lane_errors`: `memory.max == 1024 MiB` and MemAvailable ≥ 16 GiB + 1024 + 256 MiB, checked in **every** run (production and fixture). The e2e therefore also runs in the 1024 main lane.
- **M3:** both jobs check `/vm/enclave-volumes` with the **pinned bsro r7/r12 `mount_identity.py` (`fc4d1ede…`)**: UUID `aaae081c-f829-4484-a50f-a9bbb87d31f9`, `/dev/mapper/cryptvm`, ext4, 253:1. `extract.py` keeps its 253:1 check.
- **M4:** fixture mode refuses the production backup (by realpath or basename). It requires a dest matching `/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-e2e-<UTC>-<pid>[/x[/y]]` and the pinned floors (40 GiB /vm floor and the 16 GiB host floor). r1's e2e `--floor-bytes 0 --host-mem-floor 0` are gone.
- **B3, actual metadata fixture through r9 fakeroot (prepared):**
  - **The builder (`tests/make_meta_fixture.py`):** it builds `meta.qcow2` (0444) with the **pinned r9 fixture helpers** (`make_fixture.py` `7cece25e…`: `mkfs.ext4` + `debugfs -w` on a private raw, unprivileged). It contains:
    - `data` 040750 994:985;
    - `data/reth.toml` 0100640 994:985, 2590 B, **mtime 1793026310.098139981** (production's exact values; `sif … mtime @1793026310` + `mtime_extra (98139981 << 2)`);
    - `data/static_files` 040755;
    - `data/static_files/h.conf` 0100644, 75 B, mtime 1000000000.0.

    It **self-checks every value with `debugfs stat`**, independently of `extract.py`, and refuses on any difference.
  - **e2e test 7** extracts it with the FULL production-style allowlist (mode/uid/gid/mtime_ns/nlink/size/sha256) and requires CLEAN with exact metadata and bytes.
  - **e2e test 8:** a single-field change each (mtime_ns + 1 ns, uid 0, gid 0, mode 0644) must REFUSE "differs from the allowlist" with nothing copied.
  - **Production checks are unchanged** (never weakened).
- **CLEAN → state-runner mapping (new, the contract):**
  - **The function:** `state_pins(receipt, run_dir)`, exposed as the CLI `extract.py state-pins --run-dir <production run dir>`, which writes nothing.
  - **It accepts only a CLEAN production receipt:** rc int 0, CLEAN, no error/finalizationErrors, `runDir` equal, `session.rc` 0 with no reasons, no authority, `files` == the pinned 7-entry allowlist in order (sizes exact, 64-hex sha256), `totalBytes` 362900885.
  - **It returns** `{format: compact-header-static-files/v1, staticFilesDir: <run>/files/data/static_files, staticFiles: [6 × {name, size, sha256}] in allowlist order (data/reth.toml excluded), allowlistSha256, extractionReceiptSha256}`.
  - **For the state runner (agent da):** derive `staticFilesDir`/`staticFiles` only from this output. That matches acceptance r2's `pins.staticFilesDir` (outside the state run dir) and its `staticFiles` (plain names, size, sha256, order).

## Capacity (root has only about 400 MiB beyond 40 GiB + the 8 GiB native reservation)
- **E2E, all on /vm:** the fixture images, overlays (≤ 64 MiB each, deleted by r9) and dest copies live in a NEW workspace `/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-e2e-<UTC>-<pid>/`.
  - **Expected size:** about 300 MiB peak. This is my estimate (the r9 fixture is a 96 MiB sparse raw, its raw copy and 2 qcow2; meta is 16 MiB sparse). `workspace-bytes.txt` records the actual usage.
  - **Admission:** the job refuses unless /vm free ≥ the vm reservation + 40 GiB + a 2 GiB budget.
  - **Root-side writes:** only the job's KB logs under `r2/runs/`. The 2 GiB root requirement of r1 is gone.
  - **The workspace is kept** for review (owned; remove after review).
- **Production:** about 363 MB of files + a ≤ 64 MiB overlay + r9's 1 GiB free requirement, on /vm, plus the multipart reservations from `coordination.py`.

## Prepared tests (NOT run)
**Unit (16; `che-r2-unit`, 256, `unshare -Urn`):** r1's 10 plus:
- **11** the lane rule;
- **12** the fresh backup binding (incl. a pre-chmod ctime, +1 ns, 0644, ino, dev, mtime, size, tampered/absent receipt; hold 900);
- **13** `final_rc`;
- **14** `state_pins`: CLEAN → 6 files + dir; 13 mutations refused; the CLI rejects a non-production dir;
- **15** fixture mode can never touch production (the production backup, a dest outside the E2E workspace, lowered floors → rc 3, nothing created);
- **16** the metadata fixture's `debugfs` commands and its `reth.toml` entry equal production's fields.

**E2E (8; `che-r2-e2e`, 1024, only after coordination passes):** r1's 6 (now with the pinned floors and the 1024 lane, on /vm) plus 7–8 above.

## Limitations (stated, not filled)
- **No r2 test has been run.** Each item below needs its actual run.
- **`debugfs sif` forms are untried:** whether this host's `debugfs` 1.47.4 accepts `sif … mtime @<seconds>` and `mtime_extra` is unverified. If not, `make_meta_fixture` **fails closed** (its self-check or a stderr line → RuntimeError → e2e error, never a hidden pass), and the form must be adjusted in a new revision.
- **The fakeroot view is unverified:** whether `fuse2fs … fakeroot` reports on-disk uid/gid, the 0750 traversal and nanosecond mtime is exactly what tests 7–8 establish. If it differs, production refuses (correctly), and the remedy must be reviewed; the checks must never be relaxed.
- **The e2e lane:** the e2e is now in the 1024 main lane (it shares the main lane exclusivity with the multipart batches). It can only run once coordination passes: all 265 complete and no driver.
- **The owner receipt's own limit:** it states that its process inspection was incomplete ("absence of all systemwide writers was not established"). The fresh identity binding detects any metadata change, not a same-inode content write without an mtime/ctime change (not possible through normal writes on ext4).
- **Coordination is point-in-time.** The queue's main-lane exclusivity and the no-driver refusal cover the run window, as in r1 (1885 M6).
- **Not a recovery, canonical-state, structural or reset acceptance.** Production stays on HOLD until the unit + e2e actual PASS, review, all 265 CONFIRMED, and a coordinated window.
