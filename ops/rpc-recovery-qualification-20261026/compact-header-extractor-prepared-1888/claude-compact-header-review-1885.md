# 1885: independent SOURCE-ONLY review of compact-header-extraction-stage/r1 (+ a brief acceptance r2 P1/P2 check)

**What I did not do:** execute anything (tests, mounts, queue, build, network); read data, backup, part or image content; edit code; commit.

**What I read:**
- `compact-header-extraction-stage/r1`, all files; its SUMS listing is as frozen (`extract.py` `9217bee4…`);
- `logs/root-compact-header-extraction-evidence-1871.md`;
- the reused r9 `recovery-overlay-stage/r9/overlay_session.py`: SUMS `17b5528f…` and file `65d45ab7…`, matching the extractor's pins;
- the multipart manifest's `targets` metadata only (dirs and floors);
- acceptance r2 (SUMS `70144b83…`, intact) against report 1878.

**Pure/test receipts are never acceptance.** No result here, and no future unit/e2e PASS, is a recovery, canonical-state, structural or reset acceptance.

## BLOCKERS (resolve before the named action)
**B1. Do NOT run `jobs/e2e-tests.sh` while the multipart recovery driver can admit work.**
- **Why:** the e2e test starts real r9 `overlay_session.py` sessions and host FUSE mounts, not namespaced (`e2e-tests.sh`; `test_extract_e2e.py` `run_x`).
- **What it collides with:** the pinned 1773 runner's `busy_reasons` treats a running `overlay_session.py` or a stage mount as BUSY. That is the reason `jobs/coordination.py` exists, and `coordination.py` itself refuses while a `root-multipart-batches-*` driver runs.
- **The gap:** **`e2e-tests.sh` performs no such coordination.** A batch or verification admitted during the e2e window would refuse, and HANDOFF policy is "stop on any failure/refusal", so this can halt preservation.
- **Fix (smallest):** in `e2e-tests.sh`, run `python3 -I -B $C/jobs/coordination.py` first and refuse on rc ≠ 0, exactly as `root-extract.sh` does. Otherwise run it only after the driver has finished all 265.
- **Lane exclusivity is not enough:** the 512/1024 main lanes are exclusive, but the driver's own admission/busy logic runs outside that lane.

**B2. Backup writability is unestablished; production refuses if the image is writable by this user.**
- **Both layers check it:** `extract.source_identity` and r9 `prepare` both refuse `os.access(backup, W_OK)` (`extract.py:338-339`; r9 "parent is WRITABLE").
- **Unknown:** no saved evidence states the mode/owner of `…/tr004/preserved-images/base-origin.compact.qcow2`.
- **What root must decide before scheduling** (a metadata-only `stat`):
  - if it is writable, choose between `chmod a-w`, which changes the preserved image's ctime and needs RAID-owner agreement, or a read-only bind (r9 `--require-ro-mount` exists but is not used here and would need namespace work);
  - do not schedule production until that is decided.
- **Fail-closed:** a refusal (rc 3) is the safe outcome.

**B3. The production-only metadata checks are untested through the real view.**
- **The production allowlist pins** `mode`/`uid`/`gid`/`mtime_ns` for every file. This includes `data/reth.toml` with `mtime_ns 1793026310098139981` (nanosecond precision) and `uid 994`/`gid 985`.
- **The e2e allowlists** (`test_extract_e2e.py` tests 1–6) use only `path`/`size`/`nlink` (+ `sha256`).
- **So nothing verifies** that the pinned `fuse2fs` with **`ro,norecovery,fakeroot`** (r9 `FUSE2FS_OPTS`) reports on-disk uid/gid unchanged, and nanosecond mtimes, through FUSE.
- **Failure mode:** a refusal in the coordinated production window (fail-closed, but it wastes the window and the B2 coordination).
- **Fix:** an e2e case whose allowlist carries the fixture's exact on-disk mode/uid/gid/mtime_ns, taken from `make_fixture`'s build or a `debugfs stat` of the fixture image, including a non-zero nanosecond part.

## HIGH (fix before production)
**H1. `EXTRACTION-RECEIPT.json` write failure is swallowed while rc can stay 0.**
- **The code:** `extract.py:546-548` (`with contextlib.suppress(OSError): write_json(...)`). A CLEAN rc 0 with no receipt on disk is possible; the printed summary still says CLEAN.
- **Fix:** if the receipt write fails, set rc = 4 (never 0) and print that, so the final rc is consistent with the evidence.

**H2. `root-extract.sh` has no `trap ':' TERM INT HUP`** (compare bsro `build.sh` m4).
- **What happens on a queue/group TERM:** it reaches bash and `extract.py` together. `extract.py` stops gracefully (its own handlers, then RELEASE + `end_session`), but bash dies at once.
- **What is lost:** `peers-after`, the post-run SUMS check and the final rc line; the queue records 143.
- **Fix:** install the trap after the early checks, so the wrapper waits for `extract.py`'s own rc and still collects the after-evidence.

**H3. A hard kill leaves r9 holding mounts for up to an hour.**
- **The defaults:** `--hold-seconds 3600` (waiter `--max-wait`) and r9 `--exec-timeout` = hold + 300. If `extract.py` is SIGKILLed (`timeout -k`, an OOM, or `kill -9`), RELEASE is never written. The r9 session (own session, unaffected) keeps the read-only FUSE view and overlay for about 65 min, then cleans up itself.
- **The worse case:** a queue memory-guard **tree** kill also reaches r9's descendants (new sessions are still tree descendants). It leaves dead FUSE mounts and the overlay, which r9 cannot clean.
- **Fixes:**
  - default `--hold-seconds` to the measured need (the copy of ≈ 363 MB with 3 reads takes minutes; e.g. 900);
  - document the manual cleanup of `RUN/session/work/{mnt,view}` (`fusermount3 -u`) and the overlay;
  - state that any such run is not evidence.

## MEDIUM
- **M1. The order of the UUID/magic check versus first path access (1871):** 1871 asks to verify the ext4 magic/UUID **before accessing the exact inventory paths**.
  - **What happens instead:** r9 has no UUID check (grep: none). It mounts with `fuse2fs` and `stat`s/write-probes `data/reth.toml` before READY. `extract.check_fs_header` runs only after READY.
  - **Risk:** everything is read-only (`fuse2fs ro`, refused write probes, `nbd --read-only`), so the risk is low.
  - **Action:** document the deviation and accept it, or have `extract.py` read the raw superblock (magic/UUID) via r9's view before any `open_nofollow`. That is already the case for the extractor's own access; only r9's built-in target checks precede it.
- **M2. The host memory floor is 16 GiB only** (`extract.py:452`).
  - **Elsewhere:** the bsro/cmv gates use 16 GiB + lane + 256 MiB headroom and verify the cgroup `memory.max` lane.
  - **Fix:** add MemAvailable ≥ 16 GiB + 1024 + 256 MiB and `memory.max == 1024 MiB` (the documented lane).
- **M3. The /vm identity is a partial check.**
  - **Today:** only `st_dev == 253:1` is checked (`extract.py:445-446`). `PROD["destUuid"]` is defined but unused.
  - **Fix:** reuse the qualified r7 `mount_identity.py` (uuid/source/fstype/majmin, as bsro `build.sh` does) for `/vm/enclave-volumes`.
- **M4. Fixture mode can target production paths.**
  - **Today:** `--fixture` bypasses the request binding and accepts `--floor-bytes 0 --host-mem-floor 0` (the e2e tests use these) with any `--backup`/`--dest-parent`.
  - **Fix (harden):** fixture mode refuses `PROD["backup"]`, refuses any dest under `/vm/enclave-volumes`, and requires the pinned floors whenever the dest is on `253:1`.
- **M5. A refusal after the session started returns rc 3.** View/UUID/READY refusals after the session started return rc 3 "REFUSED (nothing extracted)", although mounts and a session happened (cleanly). That is acceptable, but the README/receipt should say "3 = nothing extracted", not "nothing ran".
- **M6. Coordination is point-in-time.**
  - **What protects the run:** the main-lane exclusivity of the queue (1024) for batch jobs, plus the "no driver process" refusal.
  - **What is not protected:** a driver restarted mid-run is not detected.
  - **Action:** document it, or re-run `coordination.py`'s busy part after the copy and mark rc 4 if it changed.

## Verified OK (source)
- **r9 lifecycle compatibility (no new lifecycle):**
  - **The plan:** the zero-patch plan passes r9 `prepare` (`format recovery-overlay-plan/v1`, `fs.fsOffset 0`, `patches []` ≤ 64; the overlay estimate with no spans fits the cap). Extra plan keys (`mode`, `acceptance`, `fs.uuid`) are ignored by r9.
  - **Zero patches:** `qemu-io` then runs with no `-c` and `stdin=DEVNULL` (r9 `run`). This is unexercised in production but exercised by every e2e case.
  - **Samples:** `samples []` → `samplesFollowRestoredMap` ok.
  - **The target:** `target.path "/data/reth.toml"` size 2590 → r9 `targetRegularAndSized`, write probes.
  - **The exec environment** matches `verify_ready`'s exact env (`PATH`, `LC_ALL`, `RECOVERY_TARGET = mnt + "/data/reth.toml"`): r9 `use()` sets exactly these 3 keys.
  - **The paths:** r9 `work/mnt` and `work/view/nbd` match `extract`.
  - **The receipt keys** used by `check_receipt` all exist in r9: `rc`, `cleanupComplete`, `parentUnchanged`, `planSha256`, `exec{cmd, rc, timedOut, groupLeftovers, escapedKilled}`, `children.exec.pid`, `checks`, `leftoverProcesses`, `overlayDeleted`.
  - **The waiter:** it writes only READY (< 1 KiB) under r9's `RLIMIT_FSIZE` 64 MiB. The parent does the copy after READY, and `verify_ready` pins the exec child (pidfd, ppid == session, start time, exact argv and env).
- **Read-only, no original writes:**
  - the backup is touched only by `qemu-img info -U` and as the read-only qcow2 backing of a NEW ≤ 64 MiB overlay (`qemu-img create -u -b`; `qemu-nbd --read-only`; `fuse2fs ro,norecovery`);
  - r9 refuses a writable or backed parent; identity (dev/ino/size/mtime/ctime) is checked before and after;
  - no USB/original path; no full-image hash (the saved `a3b00e5f…` is provenance only, as 1871 requires).
- **ext4/mount identity:**
  - exactly one mountinfo entry at `mnt`, `fuse*`, `ro`, source == `nbd`;
  - ST_RDONLY;
  - raw magic `0xEF53` @ 1080 and the pinned UUID @ 1128 (1871's offset-0 evidence);
  - the e2e test 1 asserts the source equality, so `fuse2fs`'s fsname behaviour gets tested there.
- **Path traversal:**
  - the allowlist rejects absolute, `.`/`..`/empty components, NUL, duplicates, non-int/bool sizes, and `nlink ≠ 1`;
  - source walks use `dir_fd` + `O_NOFOLLOW` on every component, with `O_NONBLOCK` on the leaf and a regular-file check;
  - dest dirs are created with `dir_fd`/`O_NOFOLLOW`, files with `O_EXCL` 0600;
  - `link()` never replaces; the dir is fsynced.
- **The copy:** two independent source reads + a copy re-read must hash equal; the source identity is unchanged; a mismatch keeps `.partial`; totals are exact (362,900,885; `validate_allowlist` total pinned).
- **Bounds:** ≤ 400 MiB total. The /vm need = files + 64 MiB overlay + 1 GiB r9 slack + the multipart vm reservation + its floor (from `coordination.py`). The root floor is in `coordination.py` (remaining + max(40 GiB, manifest) + 8 GiB).
- **The destination parent:** `/vm/enclave-volumes/tr004-base-recovery-20261026` is the **parent** of the multipart vm target `…/parts-vm` (manifest metadata), so the run dir is a sibling, never inside the parts dir.
- **Request binding:** the request file must be read-only and sha-pinned and equal `request_for(actual stage SUMS)` (`root-extract.sh` passes the real SUMS after `sha256sum -c`). It carries `recoveryAccepted`/`canonicalAuthority`/`resetAuthority` false.
- **Interrupts while `extract.py` lives:**
  - TERM/INT/HUP set a stop flag, checked in the READY wait and every copy chunk;
  - `finally`: RELEASE, then a bounded `end_session` (≤ 900 s + TERM/KILL 120 s each, **only our unreaped child's group**), then the receipt check, post identity, and the mount-survival check;
  - handlers are ignored during finalization, then restored.

## Are the tests safe to run?
- **Unit tests (`jobs/tests.sh`, 10, `unshare -Urn`, 256): yes, as far as source shows.**
  - They use `/tmp` temporary trees only; no mount, session or backup.
  - Test 8 spawns 2 `sleep` children and kills/reaps them in `finally`. It reads `/proc/1/environ`, which is expected to fail with EACCES, resulting in a refusal.
  - Test 9 production refusals all occur before any `/vm` or backup access.
  - A bytecode-in-stage check is included.
- **E2E (`jobs/e2e-tests.sh`, 6): NOT now** — see **B1**.
  - **Otherwise reasonable:** a fresh r9 fixture under the stage's `runs/`, never the backup; peers snapshot before/after; leftover mount/process checks; a 2 GiB free check.
  - **But:** it is host-visible FUSE (not namespaced), on root. A `timeout -k` or memory-guard kill can leave r9 holders (H3).

## Brief: acceptance r2 P1/P2 vs report 1878
**Implemented as described:**
- **`final_state_status`:** binds `helperArgv == expected_argv(pins)` (`[helperPath, --db runDir/work/db, --static-files staticFilesDir, --rocksdb runDir/rocksdb-absent, --out runDir/state-report.json, --plain-hashed]`). The report path is derived from `runDir`, and `view` has the exact r6 keys (production, 265 parts) with evidence == pins.
- **`interrupted`:** must be exactly `None`.
- **`memory`:** exactly `{memoryDirty, softStop, eventsBefore, eventsAfter}`. `memoryDirty` must equal the re-derived `counters_dirty` with exact-int oom counters, and `memory_clean` requires `softStop is None`.

**Its actual tests passed:** `runs/…/receipt.json`, `Ran 46`, pass true, stageSums `70144b83…` = the current SUMS.

**Observations (not defects in P1/P2):**
- **(a) The parser is still r11-only.** Its fixture parser still pins the r11 scripts; capture r2 (1879) needs an r12-aware revision.
- **(b) A missing cross-stage contract between this extractor and acceptance r2:**
  - `pins.staticFilesDir` must be `<extraction run>/files/data/static_files`;
  - `pins.staticFiles` must be exactly the six header files' `{name, size, sha256}` from `EXTRACTION-RECEIPT.json.files` (excluding `data/reth.toml`), in order.

  Neither stage states this mapping. The future runner must derive the pins from a **CLEAN** extraction receipt (rc 0, session reasons empty), not from a directory listing.

## Minimal next steps
1. Fix B1 (e2e coordination gate), H1 (receipt-write rc), H2 (trap), and the H3 default. Optionally harden M2–M4.
2. Add the B3 metadata e2e case.
3. Re-freeze the stage as a new revision.
4. Root: a metadata-only `stat` of the backup's mode/owner (B2), and an owner decision if it is writable.
5. Then the unit tests (safe now) and, after the driver finishes or with coordination, the e2e. Production only after all 265 parts are CONFIRMED and review, in the 1024 main lane.
