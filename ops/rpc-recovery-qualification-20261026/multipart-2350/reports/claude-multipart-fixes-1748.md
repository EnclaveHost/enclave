# recovery-multipart-stage/r2: review 1747 fixes and a MANDATORY bound r9 source session (1748). Source + tests only

**Not done by me:** no test, build, copy, sudo, mount or production read; no edit of r1, r9 or any production or source checkout.
- **Read only:** review 1747, the r1 receipt, and the frozen r9 sources (to bind to them).
- **Unchanged and verified:** r1 (`e248ee99…`; root receipt `runs/tests-20261026T233115Z-2471015`: 18 PASS) and r9 (SUMS `17b5528f…`).

**Prepared tests are not an actual PASS.** Root runs all of them through the queue.

## Stage: `recovery-multipart-stage/r2`, FROZEN
**`SHA256SUMS` = `f8a75a7e3caa008c74e6d1fb5616bd51330423b45211976fad429fded1ac5674`.**

| file | sha256 |
|---|---|
| `multipart.py` | `a88324f65878a9668b918bab1232477c11267160351786488deb13779eb24669` |
| `orchestrate.py` | `550b23d32bbaba6cc65586223abc0eb5bb77c17fbf57a51703ad88ffd7aafd02` |
| `tests/test_multipart.py` (26 unit) | `9ea05aac3c25efb4282002b1afbce1386bfa13435bbc1f9bb087fbe49c7413f0` |
| `tests/test_e2e.py` (6 end-to-end) | `16f4ff564745030a998b75677cd5dcfa3f70d1f52023f16cfeeb2e91bbcbe47b` |
| `jobs/tests.sh` | `d891103a0d847c309e5d15c068b141ab10a30c45325e86ef0976ad9b0671f552` |
| `jobs/e2e-tests.sh` | `26ce466484b7ae4200bc3608f5d25c5cc439cb752541d49d4345f00645627014` |
| `jobs/root-preservation.sh` (gated, not authorized) | `16c268a1c4e661234e5755cf09779189733dda53cb438b5f11671e32a2d3a745` |
| `README.md` | `69c044dc026dcd93ad38db228789c7667b403a9448aca054e770badbc76105c8` |

## Review 1747 findings, as fixed (`multipart.py`)
- **P1 (the sparse checkpoint):** before every checkpoint's `fsync`, `if fstat.size < pos: ftruncate(tfd, pos)`. The temp size then always equals `committedBytes`, and the prefix hash reads hole zeros exactly as hashed.
  - **Test:** stops at 40960 (hole start), 49152 (after a hole), part 2's tail-hole start, and inside the tail hole. Each must leave `.partial` size == checkpoint, then resume byte-exact and verify.
- **P3 (stale status; historical vs fresh):**
  - **Records:** every commit and verify record binds `destIdentity` (dev, ino, size, mtime_ns, ctime_ns, nlink) and the full source `binding`.
  - **`status`** reports RECORDED state only (`freshlyMeasured: false`). It counts a part only if the current `lstat` equals the record, nlink == 1, and the binding is counted (fixture kinds, or a CONFIRMED session).
  - **Verify records** must be strictly valid (exact keys, run id equal to the file name, identity equal to the file, all hashes equal, measured after the commit). Otherwise the part is `invalidRecords` or not counted.
  - **Visible states:** `stale`, `unconfirmed`, `invalidRecords`, `failedVerification`.
  - **Fresh evidence** comes only from `verify` output (`freshlyMeasured: true`).
  - **Tests:** a new inode with identical bytes, or a touch, → `stale`; a malformed record → `invalidRecords`; a forged PASS with a non-matching identity is not counted.
- **P4 (long resume):** the committed-part full re-hash pre-pass runs BEFORE the source (or session) is opened. If everything selected is already present, no source is opened at all. The server socket has no idle timeout (the session's exec deadline bounds it).
  - **Test:** a resume with every part present needs no server and creates no socket; with one part missing, the pre-pass completes before the server is needed.
- **P5 (hardlinks and crash windows):** every part check requires nlink == 1, so an external hardlink is refused everywhere and the files are kept.
  - **The link/unlink crash window:** a `.partial` of the SAME inode is dropped; a different inode is refused and both are kept.
  - **Cancelled accept:** a cancelled `SocketSource` accept removes its own socket, and only a socket it created (a foreign `mp.sock` is refused and left alone).
  - **Tests:** a constructed crash state (a part without a record plus a same-inode `.partial`, and a part without a record plus a stale record temp) is adopted after a source re-read; a different-inode `.partial` is refused; SIGTERM during accept removes the socket.
- **P7 (the commit section):** link, unlink(`.partial`), the commit record and the checkpoint removal are ONE `critical()` section.
- **Floors:**
  - the memory floor is enforced on `verify` too: before the targets, and at every checkpoint interval (test);
  - `floors()` re-checks the ACTUAL target filesystem binding (`st_dev`, plus UUID/USB in production) at every checkpoint, with the full remaining reservation.
- **The test environment:** `MULTIPART_TEST_TMP` / `MULTIPART_E2E_WORK`; `TEST_TMP`/`TMPDIR`/`HOME` are never repurposed.

## Production source binding: `orchestrate.py` (r9 unchanged; the socket server is kept)
**Why this design:** r9 stays byte-identical. The only new trust is local owned-process provenance, and it fails closed.

1. **A separate, purpose-bound request:** `recovery-multipart-preservation-request/v1`.
   - Exact keys; purpose `preservation-copy`; `recoveryAccepted`/`productionUse`/`raidReset` JSON false; mode copy|verify; kind.
   - Bound to the manifest sha, the overlay plan sha, the parent path, and the sha256 of `multipart.py`, `orchestrate.py` and r9 `overlay_session.py` (`65d45ab7…`).
   - **The MDBX diagnostic request is not a preservation-copy permit.**
2. **Before any run dir or session exists:**
   - every r9 file is verified against its pinned SUMS;
   - the plan dir sha equals the manifest's; the parent equals the manifest's original;
   - production: the original is on `ST_RDONLY`, and only the pinned plan, parent and fuse2fs are accepted;
   - `bind_inputs` (map/plan/journal re-hash, holes, patches, original identity).
   - **Then** a NEW 0700 run dir holds private, re-hashed copies of `overlay_session.py` and `multipart.py`, and only those are executed.
3. **Ordering:** admission and the pre-pass, then listen, then the session as our OWN child (`start_new_session`; the handle is held, and the pid is never reaped while in use).
4. **Peer provenance** (no reliance on "same uid cannot exit/reuse"):
   - `SO_PEERCRED` pid → `pidfd_open`;
   - `/proc/<pid>/stat` ppid == our unreaped session child;
   - exact cmdline (the session's `--exec` argv) and exact environment (r9's `PATH`/`LC_ALL`/`RECOVERY_TARGET`);
   - the start time read twice, and the pidfd still not readable (alive throughout).
5. **The target, observed independently:**
   - `lstat` of `RUN/session/work/mnt/data/db/mdbx.dat`: regular, of the logical size;
   - `statvfs` `ST_RDONLY`;
   - exactly one mountinfo entry at `RUN/session/work/mnt`: `fuse*`, `ro`, source `RUN/session/work/view/nbd`;
   - the hello's identity and `mnt_id` must equal these.

   `serve --session-run-dir` refuses `--source`, any `RECOVERY_TARGET` other than the exact path, and a non-`ST_RDONLY` target. Everything is re-checked at every checkpoint (the server pidfd, the session alive, the identity, the mount).
6. **Session confirmation from the r9 receipt:** the only receipt, rc 0, `cleanupComplete`, `parentUnchanged`, the plan sha, exec rc 0 with exactly our argv and the accepted pid, all checks ok, no leftovers, the overlay deleted.
   - **Where it is written:** `session-<id>.json` CONFIRMED/UNCONFIRMED in every target.
   - **Effect:** UNCONFIRMED-session records count only after a fresh verify PASS in a CONFIRMED session.
   - **Signals:** the session end and the confirmation run with signals ignored, bounded (900 s natural end, then TERM/KILL of our own child's group only).

## Tests
**Unit (26), `jobs/tests.sh`:**
- **r1 behaviour kept and adapted:** positive two-target copy/verify, SIGTERM mid-part, corrupt/truncated destination, a source changed after the copy, a source missing, a non-zero hole byte, write failure via EFBIG, `serve` under a 16 KiB `RLIMIT_FSIZE` plus the negative control, changed bindings, manifest coverage, symlinks/foreign files, wrong filesystem/capacity/memory, concurrency, production pins, USB sysfs, the findmnt parser.
- **New:** the 4 sparse checkpoint positions; stale (new inode / touch); malformed/forged records; an external hardlink; the crash windows; the pre-pass before the source; cancel during accept (and a foreign socket left alone); `serve` session-mode refusals (`--source`, a wrong target, a writable fs); the memory floor on verify; the preservation request exactness (11 negatives).

**End-to-end (6), `jobs/e2e-tests.sh`:** the REAL r9 fixture (debugfs-made ext4, deleted and inode-reused `parent-clean.qcow2`), r9 `overlay_plan.py` fixture plan, and the r9 session with `serve`. The oracle is r9's model sha (`target.expectedSha256`). Two target dirs on the same filesystem (fixture only).
- **E1:** copy, then verify in a SEPARATE session; both CONFIRMED; receipt rc 0, `cleanupComplete`, `parentUnchanged`; reassembly == the r9 model; records bound to the session and target.
- **E2:** a wrong plan sha, production kind, a wrong mode, `recoveryAccepted` true, another parent (`parent-reused`), another plan dir → rc 3 before any run dir.
- **E3:** an impostor same-uid peer connecting first → refused ("not a child of our session"); the session cleans up; nothing bound.
- **E4:** SIGTERM while waiting for the server → rc 5; socket removed; session cleanup complete.
- **E5:** a budget stop (rc 5, CONFIRMED), then resume in a new session, then verify.
- **E6:** the server SIGKILLed mid-copy → rc 4, the session UNCONFIRMED (receipt rc 6, cleanup complete); the committed part shows `unconfirmed` until a fresh verify in a CONFIRMED session; then everything is complete and equal to the model.
- **After every E2E test:** the parent sha is unchanged and no mount is left. The job also requires the peers to be unchanged and both stages to be unchanged.

## Root commands
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh rmp-r2-tests 512 unshare -Urn bash recovery-multipart-stage/r2/jobs/tests.sh      # expect "## PASS (26)"
bash jobs/q-exit-status.sh rmp-r2-e2e 1024 bash recovery-multipart-stage/r2/jobs/e2e-tests.sh                 # expect "## PASS (6)"; FUSE, as owner, not unshare
```
- **Production (NOT authorized):** `jobs/root-preservation.sh REQUEST REQUEST_SHA MANIFEST MANIFEST_SHA copy|verify [FIRST-LAST]`. It requires passing unit AND e2e receipts of this frozen stage, the r9 guards, the original's mount `ro` and not writable, and a peer snapshot unchanged. It also needs the manual go-ahead, root-made empty target dirs, and capacity.

## Unverified assumptions / not done (explicit)
- **The mountinfo source and fstype of r9's fuse2fs mount** (expected: source = `work/view/nbd`, fstype `fuse*`, `ro`) are taken from r9's code, not observed. If they differ, E1 fails (fail closed) and the check needs adjusting after root sees the real line.
- **Not covered by fixtures:** production `--require-ro-mount` (r9's own tests cover it), real ENOSPC, and `fsync` failure.
- **Residual timing assumptions:** E3, E4 and E6 rely on session start-up taking longer than a 10 ms poll, and on a 4 KiB-chunk copy being slower than a 5 ms poll. They are made deterministic by SIGSTOP and by waiting on states, but are not proven timing-free.
- **Capacity** for the production split is not available; admission refuses.
- **No claim** of data authenticity, recovery or RAID readiness. Verification proves only that the destination equals the bound read-only view at that time.
