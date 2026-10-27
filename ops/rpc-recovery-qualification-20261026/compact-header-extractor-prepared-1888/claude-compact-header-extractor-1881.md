# Compact-header extractor 1881: compact-header-extraction-stage/r1. Source only; nothing is run or qualified

## Status
- **Source exists and is frozen.** `SHA256SUMS` lists all 8 files, and `sha256sum -c` gives 8/8 OK (re-checked now). All files are read-only.
- **Nothing has been run:**
  - not executed by Claude: no test, queue job, build, session, mount, extraction, network access, or backup/production/original read;
  - the only checks were static: `ast.parse` and `bash -n` (no execution, no bytecode).
- **Not qualified:** there are no PASS claims. The code is **not** a recovery, canonical-state, structural or reset acceptance, and claims no authority for any of them.
- **No commits.** The other tasks' stages (acceptance r2, base-state r12, fixture-capture r2) and the source checkout are untouched. r9 and the 1773 runner are reused without edits.
- **Task 1881 overran:** it used 30 turns, and this report was written afterwards on request. No implementation changed after the freeze.

## Pins (actual)
| file | sha256 |
|---|---|
| `compact-header-extraction-stage/r1/SHA256SUMS` | `bd333afa934b41774e79e0c910c7e72affad4a494ead320a25382c0b59d3e90f` |
| `README.md` | `58c8ed6138c547b603ea1c05c7da7e9720965818a5b581361731e78ead570a1a` |
| `extract.py` | `9217bee4c6131f439d2100d447cd01c8b1d7a630be7749ee2ffdf2b183b478be` |
| `jobs/coordination.py` | `0f4e95d04eea7ef3ef20293681dd1333fb53aba315cd467a2db4d0370f8f0da2` |
| `jobs/tests.sh` | `abfb5bcde1529db46eca8db0e063c15da466282caf126b2f4ebf8d28ba9b6839` |
| `jobs/e2e-tests.sh` | `de637f651f9460809547f40af360a7c181558d4327e60aa8aca2412111500bfd` |
| `jobs/root-extract.sh` | `c7596d10b4c3704d0a6ca3afb6f1b23a47118d7cbb0b7265640354ccdf5f2e1d` |
| `tests/test_extract_unit.py` (10 tests) | `a1c20afda174094b45d169b6da6d81b00a64fad2abae1c20580b55af01232bb4` |
| `tests/test_extract_e2e.py` (6 tests) | `cf4cc8cfebf34f7d6b7c9fa91d95fb76fd5d3d37ed181c552036eec7aed25371` |

**Pins the code checks:**
- **Reused code:**
  - r9 `SHA256SUMS` `17b5528fc122203708dc3cce1ddfdf4e3151ff02ec21d09b55cd651fbcd103b3`; every r9 file is re-hashed;
  - r9 `overlay_session.py` `65d45ab79da8e134772374ec7298cd3a53fc54d68ecb3b3fd407eec4874a8153`;
  - fuse2fs `…/tr004/fuse2fs-package/usr/bin/fuse2fs` `6e3b5404898c2e55cb97b75c79f7bf067d1fa3381647b458fb7904b43bc4927b`;
  - 1773 runner `5c33f6e24d0b880d47521c08a001c6b8d11af18cfcc044c411ef09a889ad410a` (its import re-verifies multipart r3 SUMS `fcd8e097…`);
  - multipart manifest `f94807f71c93b1ef639c224dfefb3b6c0f3e7b9289def91fc52b0e79864821a9`.
- **Backup and filesystem:**
  - backup `/home/steven/Documents/Codex/2026-10-26/my/work/tr004/preserved-images/base-origin.compact.qcow2`, size 120867323904;
  - SHA `a3b00e5f0b4af372bdd479bd5bdaad48ce3a95438aa1879790d637641c95df9e` is **provenance only: never re-hashed**;
  - ext4 at offset 0: UUID `11c6bbac-f823-4052-a87a-066eed6ad590`, block 4096, fsBlocks 976562500.
- **Destination:** parent `/vm/enclave-volumes/tr004-base-recovery-20261026`, which must be on device 253:1.
- **Allowlist:** hard-coded from `canonical-state-input-inventory-1859/compact-backup-reconciliation.json` (sha256 `8db4b41bd25b7b1153299154ef277bdd790ca4ff908d2ff2d2f8d7b6339580bb`, recorded in the request). All seven files are uid 994, gid 985, nlink 1. Total **362,900,885 B** (≤ 400 MiB enforced).

  | path | mode | size (B) | mtime_ns |
  |---|---|---|---|
  | `data/reth.toml` | 33184 | 2590 | 1793026310098139981 |
  | `data/static_files/static_file_headers_52500000_52999999` | 33188 | 318751407 | 1000000000 |
  | `data/static_files/static_file_headers_52500000_52999999.conf` | 33188 | 75 | 1000000000 |
  | `data/static_files/static_file_headers_52500000_52999999.off` | 33188 | 12000009 | 1000000000 |
  | `data/static_files/static_file_headers_53000000_53499999` | 33188 | 30982072 | 1000000000 |
  | `data/static_files/static_file_headers_53000000_53499999.conf` | 33188 | 75 | 1000000000 |
  | `data/static_files/static_file_headers_53000000_53499999.off` | 33188 | 1164657 | 1000000000 |

## Scope and design (as written; unverified until the root tests below)
- **Reuse seam:** there is no new mount or process lifecycle. `extract.py run` starts a sha-checked **private copy of r9 `overlay_session.py`, unchanged**, as its own unreaped child (`start_new_session`), with a generated **zero-patch** plan (`patches: []`, `samples: []`, target `/data/reth.toml` size 2590). r9 provides:
  - the read-only qcow2 backing of a ≤ 64 MiB overlay, behind `qemu-nbd --read-only`, `nbdfuse -r` and fuse2fs `ro,norecovery`;
  - its own refusals: a parent writable by this user, not qcow2, with a backing chain, or too small;
  - its write-refusal checks, cleanup, reaping, overlay deletion and parent-identity receipt.
- **The waiter:** r9's `--exec` is a private copy of `extract.py waiter`. It writes READY (pid, starttime, target) and waits for RELEASE, bounded by `--hold-seconds` (3600). It writes no data.
- **READY is accepted only from our session's exec child.** The checks are:
  - **process:** pidfd; ppid == our session child; exact argv; exact r9 env (`PATH`, `LC_ALL`, `RECOVERY_TARGET`); starttime stable; pidfd alive;
  - **mount:** exactly one mountinfo entry at `RUN/session/work/mnt` (`fuse*`, `ro`, source `RUN/session/work/view/nbd`) and `ST_RDONLY`;
  - **filesystem:** ext4 magic `0xEF53` at byte 1080 and the pinned UUID at 1128, read from the read-only nbd view.
- **Copy:** done by the parent process, outside r9's `RLIMIT_FSIZE`, only after every r9 check passed.
  1. Every entry's metadata is checked first: O_NOFOLLOW on every path component, a regular file, nlink/size/mode/uid/gid/mtime_ns equal to the allowlist. Any mismatch refuses before any copy.
  2. Each file goes to `.partial` (O_EXCL 0600, dirs 0700) in 8 MiB chunks, then fsync.
  3. A second independent source read and a re-read of the copy must hash equal, and the source fstat must be unchanged.
  4. Then link without replace, unlink the `.partial`, and fsync the dir. The session/exec/view is re-checked before each file.
- **Before and after:**
  - backup lstat identity (dev/ino/size/mtime/ctime), with no symlinked ancestors and not writable by the user;
  - `qemu-img info -U` (qcow2, no backing, virtual size ≥ the filesystem);
  - the r9 receipt: one receipt, rc 0, `cleanupComplete`, `parentUnchanged`, plan sha, exec rc 0 with our exact argv and the READY pid, all checks ok, no leftovers, `overlayDeleted`;
  - no mount under RUN.
- **Ending:** the session is always released (RELEASE). Ending is bounded: the natural end, then TERM and then KILL to **our own unreaped child's group only**. There is no stale-PID authority and no blind kill.
- **Receipt:** `RUN/EXTRACTION-RECEIPT.json` (`canonicalAuthority`/`resetAuthority` false).
- **Exit codes:** 0 CLEAN; 3 REFUSED; 4 FAILED (kept); 5 STOPPED (SIGTERM at a chunk boundary; `.partial` never renamed).
- **Floors:**
  - **`/vm` free** ≥ files + 64 MiB overlay + 1 GiB + the remaining multipart vm reservation + max(40 GiB, manifest floor);
  - **root free** ≥ the remaining multipart root reservation + max(40 GiB, floor) + 8 GiB, checked in `coordination.py`;
  - **MemAvailable** ≥ 16 GiB.
- **Production gate:** a root-written request must equal `extract.py request --stage-sums <SUMS sha>` exactly (purpose-bound; `recoveryAccepted`/`canonicalAuthority`/`resetAuthority` false), plus `--request-sha256`. The pinned floors cannot be lowered.

## Blockers and unverified items (must be cleared or confirmed by root)
1. **The backup must not be writable by the owner.** Both r9 and `extract.py` refuse a parent that `os.access(W_OK)` reports writable. I did not stat the backup.
   - If it is writable, this is a **BLOCKER**: making it 0444, or mounting it read-only, is the RAID owner's decision and is not done here.
   - `--require-ro-mount` is not used, because the backup's filesystem is rw. The protection is the read-only qcow2 backing, plus the identity check before and after.
2. **Zero-patch `qemu-io`:** r9 runs `qemu-io --image-opts …` with **no `-c`** and stdin DEVNULL. I expect it to quit on EOF with rc 0 and no "error/failed/cannot/denied" text, but this is UNVERIFIED. If it fails, r9 refuses (fail-closed), and the minimal fix would be a new r9 revision that skips `qemu-io` when there are no patches. E2E test 1 qualifies this.
3. **The mount entry:** I assume fuse2fs's mountinfo source is exactly the nbd path and its fstype starts with `fuse`. This is unverified and fail-closed; e2e tests 1 and 6 qualify it.
4. **r9 receipt key names** (`leftoverProcesses`, `overlayDeleted`, `cleanupComplete`, `parentUnchanged`, `exec.*`, `children.exec.pid`) come from my earlier reading of r9. They are fail-closed, and e2e test 1 qualifies them.
5. **Backup virtual size:** it must be ≥ 976562500 × 4096 = 4,000,000,000,000 B, or r9 and `extract.py` refuse. The value is not known to me; it is checked only at job time.
6. **No full-image hash:** there is no full 120 GB re-hash. The binding is fresh identity plus the saved-SHA provenance only.
7. **Destination binding:** only device 253:1 is checked. The `/vm` UUID `aaae081c…` is defined in `PROD` but **not checked** (a gap). The destination parent must already exist and be owner-writable.
8. **Coordination:**
   - the job refuses while any multipart driver/batch, orchestrate, overlay session or stage view is active, so root must run it **between** multipart driver runs;
   - a multipart driver started *during* the extraction would see our overlay-session process; its next batch would refuse (rc 3) and stop that driver;
   - root free and MemAvailable are checked once, at start.
9. **SIGKILL of `extract.py`:**
   - no RELEASE and no extraction receipt;
   - the session's waiter times out after ≤ 3600 s and r9 cleans up;
   - files may be `.partial`; root must inspect.
10. **Partial result on failure:** a mid-run Fail (hash mismatch, or the view changed) keeps the files already committed and labels the outcome FAILED. Metadata mismatches refuse before any copy.
11. **Output files** are 0600 and owned by the owner. The original uid/gid/mode/mtime are recorded in the receipt, not restored.
12. **E2E test 6 is timing-dependent:** SIGTERM is sent once `session/work` appears, and the test assumes READY has not been reached yet.

## Required root tests (none run; expected counts)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh che-r1-unit 256 unshare -Urn bash compact-header-extraction-stage/r1/jobs/tests.sh   # expect "## PASS (10)"
bash jobs/q-exit-status.sh che-r1-e2e 512 bash compact-header-extraction-stage/r1/jobs/e2e-tests.sh            # FUSE, not unshare; expect "## PASS (6)"
```

**Unit tests (10):**
1. The production allowlist is exact (7 files, 362,900,885 B).
2. Allowlist refusals.
3. Copy with double read, no replace, and `.partial` kept on a hash mismatch.
4. Symlinks (file, directory, ancestor), FIFO, a missing path, a hardlink and metadata drift are refused.
5. A stop leaves only a `.partial`.
6. The plan, `qemu-img info` and receipt checkers.
7. The mountinfo view and the ext4 magic/UUID.
8. READY is accepted only from our exec child (owned processes).
9. Production refusals happen before anything is created.
10. The coordination filter.

**E2E tests (6):** these run real r9 sessions over a freshly built r9 `parent-clean.qcow2`, never the backup.
1. A clean extraction of `data/db/other.dat` (equal to `content(3)[:5000]`) and the empty `mdbx.dat`, with the parent unchanged.
2. A missing path is refused (rc 3) and nothing is copied.
3. A metadata mismatch is refused before any copy.
4. A wrong UUID is refused.
5. A writable parent is refused before anything starts.
6. SIGTERM during session start: rc 5, STOPPED.

Every run must also show: session reasons `[]`, no mount or process left, peers unchanged, and the stage unchanged.

## Production (only after both PASS, review, and blocker 1 resolved; main lane, coordinated, never automatic)
```
S=compact-header-extraction-stage/r1
python3 -I -B $S/extract.py request --stage-sums bd333afa934b41774e79e0c910c7e72affad4a494ead320a25382c0b59d3e90f > REQ   # review; make read-only
bash jobs/q-exit-status.sh che-r1-extract 1024 bash $S/jobs/root-extract.sh REQ "$(sha256sum < REQ | cut -c1-64)"
# graceful stop: kill -TERM the extract.py pid only (never the queue / q-wrapper)
```
- **Output:** a NEW `/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-<ts>-<pid>/` containing `files/`, `EXTRACTION-RECEIPT.json` and `session/receipt.json`.
- **Job logs:** `$S/runs/extract-*/` (coordination, extract out/err, peer snapshots).
