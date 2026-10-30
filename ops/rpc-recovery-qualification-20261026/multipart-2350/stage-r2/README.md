# recovery-multipart-stage/r2: preservation copy with a MANDATORY bound r9 source session
(PREPARED by Claude 1748, SOURCE + tests only; NOTHING built, run or tested by Claude. Report: logs/claude-multipart-fixes-1748.md)

**Status: PENDING.**
- **Tests:** not yet run (root runs `jobs/tests.sh` and `jobs/e2e-tests.sh`). Prepared tests are not an actual PASS.
- **Production:** `jobs/root-preservation.sh` is prepared but NOT authorized. It needs a manual go-ahead, capacity, review, and passing receipts of this frozen stage.
- **r1** (`e248ee99…`, 18 tests PASS, root receipt `runs/tests-20261026T233115Z-2471015`) is unchanged.
- **Never** a recovery, data-integrity, RAID-reset or production-ready statement.

## Files
| file | role |
|---|---|
| `multipart.py` | manifest, copy, verify, status, `serve` (r1 plus review 1747 P1/P3/P4/P5/P7) |
| `orchestrate.py` | the ONLY production path: one owned r9 session per run, peer provenance, receipt-based session confirmation |
| `tests/test_multipart.py` | 26 unit tests (`jobs/tests.sh`, `unshare -Urn`) |
| `tests/test_e2e.py` | 6 end-to-end tests with the REAL r9 fixture and session (`jobs/e2e-tests.sh`, FUSE, not under unshare) |
| `jobs/root-preservation.sh` | the production wrapper (gated; not run) |

## The production source binding (orchestrate.py)
1. **The request:** a root-written `recovery-multipart-preservation-request/v1`.
   - Exact keys, purpose `preservation-copy`, and `recoveryAccepted`/`productionUse`/`raidReset` all JSON false.
   - It is bound to the manifest sha, plan sha, parent path, and the sha256 of `multipart.py`, `orchestrate.py` and r9 `overlay_session.py`.
   - It is distinct from the r8/r9 MDBX diagnostic request.
2. **r9 is verified:** its SUMS pin and every file. `overlay_session.py` and `multipart.py` are copied into the run's private dir and re-hashed, and only the copies are executed.
3. **Before any session exists:** admission and the full re-hash pre-pass. If every selected part is already present, no session is started at all.
4. **The session:** the copier listens on a 0700 socket dir, then starts the r9 session as its OWN child (the handle is held and never reaped early). The session's `--exec` is `/usr/bin/python3 -I -B RUN/multipart.py serve --socket-dir RUN/sock --expect-size L --session-run-dir RUN/session`.
5. **The ONE accepted peer must be that exec:**
   - **Process identity:** `SO_PEERCRED` pid → `pidfd_open`; ppid == our session child; exact cmdline; exact r9 environment; start time stable; pidfd alive.
   - **The hello:** it must match our own observation of `RUN/session/work/mnt/data/db/mdbx.dat`: the lstat identity, `ST_RDONLY`, and a mountinfo entry that is a fuse mount, with `ro`, sourced from `RUN/session/work/view/nbd`, with the same `mnt_id`.
   - **Re-checked at every checkpoint.**
6. **Session confirmation:** the source sends `Q`, and the session ends (bounded; only our child's group is ever signalled). The r9 receipt must show:
   - it is the only receipt; rc 0; `cleanupComplete`; `parentUnchanged`; the plan sha;
   - exec rc 0 with exactly our argv and the accepted pid; all checks ok; no leftovers; the overlay deleted.

   The session is then recorded `CONFIRMED`/`UNCONFIRMED` in every target. Records of an UNCONFIRMED session count again only after a fresh verify PASS in a CONFIRMED session.
7. **Production only:** `--require-ro-mount`, and only the pinned plan dir, parent and fuse2fs. `multipart.py copy`/`verify` refuse production manifests outright. The `fixture-file` source is fixture-only and labelled as such in every record.

## NOT done / limits (honest)
- **Not executed:** nothing here has been executed.
- **E2E assumptions:** the E2E tests assume r9's fuse2fs mount appears in mountinfo with source = the nbdfuse file and a `fuse*` fstype. If that differs, E1 fails loudly and the check must be adjusted; it is never relaxed silently.
- **Production `--require-ro-mount`** is exercised only by r9's own tests, not by this stage's fixture (a fixture parent is not on a read-only mount).
- **Faults not faked:** `fsync` failure and real ENOSPC are not faked. Write failure is tested via `RLIMIT_FSIZE` (EFBIG).
- **Capacity:** at the last measurement, capacity for the production layout (120 × 4 GiB + 40 GiB on `/`, 145 × 4 GiB + 40 GiB on `/vm`) is not available. Admission refuses.
