# compact-header-extraction-stage/r2 (prepared by Claude 1881/1892; nothing run by Claude; NOT PASS)
**Report:** `../../logs/claude-compact-header-corrections-1892.md`, which answers review 1885. r1 (`bd333afa…`) is preserved; root's actual r1 unit tests passed 10, and no r1 e2e was run.

**This is NOT a recovery, canonical-state, structural or reset acceptance.** Pure/test receipts never are.

## What r2 changes (r9 lifecycle unchanged; no new lifecycle, framework or kill path)
- **B2, the backup's fresh read-only identity:** the RAID owner's `chmod 0444` receipt is pinned (sha `928d09ba…`). Production refuses unless the backup's FRESH `lstat` equals that receipt's post-chmod state: dev 64768, ino 4856848, size 120867323904, mode 0444, mtime_ns …070631, ctime_ns 1793097367170099837. **The pre-chmod ctime is never used.** Any later metadata change refuses until a new owner receipt is reviewed.
- **B1, ALL 265 and an inactive driver for BOTH E2E and production:** `jobs/coordination.py` adds the pinned bsro r12 `live_completion` (the all-265 gate) to the busy/driver/floor checks. There is no exception and no driver pause. Order, in both jobs: r9 `guards`, then the pinned `mount_identity.py` for /vm, then coordination. Only after that comes any fixture build, mount or session.
- **H1:** if `EXTRACTION-RECEIPT.json` cannot be written, the rc is never 0 (`final_rc`).
- **H2:** both jobs `trap ':' TERM INT HUP` after their early checks. `extract.py` stops gracefully (RELEASE, then the bounded `end_session` of OUR child only), and the wrapper still takes its final evidence.
- **H3:** hold 900 s (r9 `--exec-timeout` 1200 s). See the manual cleanup below.
- **M2:** `memory.max` must be exactly 1024 MiB (the main lane), and MemAvailable ≥ 16 GiB + 1024 MiB + 256 MiB, in every run (production and fixture).
- **M3:** the /vm identity uses the pinned bsro r7/r12 `mount_identity.py` (`fc4d1ede…`): `--target /vm/enclave-volumes`, UUID `aaae081c…`, `/dev/mapper/cryptvm`, ext4, 253:1. `extract.py` still checks 253:1 itself.
- **M4:** fixture mode refuses the production backup (by realpath or name). It requires a dest inside a /vm E2E workspace `…/tr004-base-recovery-20261026/compact-header-e2e-<UTC>-<pid>[/x[/y]]` and the same pinned floors.
- **B3:** the metadata fixture `tests/make_meta_fixture.py` (built with the pinned r9 fixture helpers; it self-checks with `debugfs stat`) has:
  - `data` 0750 994:985;
  - `data/reth.toml` with production's exact mode/uid/gid and nanosecond mtime (1793026310.098139981);
  - one `.conf`.

  e2e tests 7–8 extract it through r9's real `fuse2fs ro,norecovery,fakeroot` view with the FULL production metadata allowlist. A one-field mismatch must REFUSE; the production checks are never weakened.

## The CLEAN extraction → state-runner mapping (the contract for the state runner)
**The command (writes nothing):** `python3 -I -B extract.py state-pins --run-dir /vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-<UTC>-<pid>`

**When it prints pins:** only when that run's `EXTRACTION-RECEIPT.json` is a **CLEAN** production extraction:
- `rc` exactly int 0 and `outcome` CLEAN;
- no `error`/`finalizationErrors`;
- `runDir` equal;
- `session.rc` 0 and `session.reasons` [];
- no canonical/reset authority;
- `files` = exactly the pinned 7-entry allowlist in order (sizes pinned, sha256 64-hex);
- `totalBytes` 362900885.

**What it prints:**
- `staticFilesDir` = `<runDir>/files/data/static_files`;
- `staticFiles` = the SIX header files `{name, size, sha256}` in allowlist order (52500000_52999999, `.conf`, `.off`, 53000000_53499999, `.conf`, `.off`). `data/reth.toml` is excluded; it is not a static file;
- `allowlistSha256` and `extractionReceiptSha256` (to be pinned).

**For the state runner:** derive its pins ONLY from this output, never from a directory listing. It also needs the extraction run's other evidence (`session/receipt.json`), which the CLEAN check already binds.

## Manual cleanup after a HARD kill (documented only; nothing automatic)
**When this applies:** if `extract.py` was SIGKILLed, the r9 session may hold its read-only view for up to hold + 300 s, after which it cleans up itself. A memory-guard **tree** kill can leave dead FUSE mounts and the overlay.

**Steps (root, owner only, never another user's process or mount):**
1. Inspect `RUN/session/receipt.json` (if any) and `RUN/session.out`.
2. Find candidate processes with `pgrep -u $(id -u) -a -x 'qemu-nbd|nbdfuse|fuse2fs'`. Keep ONLY the PIDs whose `/proc/PID/cmdline` names THIS `RUN/session/work`, and check `/proc/PID/status` Uid is yours. Then `kill -TERM` exactly those PIDs, and SIGKILL only if they persist after 60 s.
3. Unmount ONLY the mountinfo entries at `RUN/session/work/mnt` and then `RUN/session/work/view`, with `fusermount3 -u` (or `-uz` if the FUSE server is gone).
4. Remove only `RUN/session/work/overlay.qcow2`. Keep everything else as evidence. Such a run is never CLEAN.

## Commands (root; never automatic)
```
bash jobs/q-exit-status.sh che-r2-unit 256 unshare -Urn bash compact-header-extraction-stage/r2/jobs/tests.sh     # "## PASS (16)"
# ONLY when coordination passes (all 265 complete + verified, no driver/batch/session), in the 1024 main lane:
bash jobs/q-exit-status.sh che-r2-e2e 1024 bash compact-header-extraction-stage/r2/jobs/e2e-tests.sh                # "## PASS (8)"
python3 -I -B compact-header-extraction-stage/r2/extract.py request --stage-sums "$(sha256sum < compact-header-extraction-stage/r2/SHA256SUMS | cut -c1-64)" > REQ   # review; chmod a-w
bash jobs/q-exit-status.sh che-r2-extract 1024 bash compact-header-extraction-stage/r2/jobs/root-extract.sh REQ "$(sha256sum < REQ | cut -c1-64)"
```

**Capacity:**
- **E2E:** all fixtures, overlays and outputs live in a NEW /vm workspace (about 300 MiB expected). The job requires /vm free ≥ the vm reservation + 40 GiB + a 2 GiB budget. Root-side writes are only this job's KB-sized logs.
- **Production:** about 363 MB of files + a ≤ 64 MiB overlay on /vm.
