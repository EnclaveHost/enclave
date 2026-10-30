# recovery-multipart-stage/r1: resumable, independently verified multipart PRESERVATION copy of the reconstructed read-only recovery target
(PREPARED by Claude 1746, SOURCE + tiny tests only; NOTHING built, run or tested by Claude. Report: logs/claude-multipart-preservation-1746.md)

**Status: PENDING.**
- **Tests:** not yet run (root runs `jobs/tests.sh`).
- **No production run is possible from this stage:** there is **no reviewed production wrapper** (see below), and capacity is not available. There is no go-ahead for bulk.
- **Never** a recovery, data-integrity, RAID-reset or production-ready statement.

## What it is
`multipart.py` (stdlib only; sequential `os.pread`/`os.pwrite`, bounded 8 MiB buffers, concurrency 1):

| command | does |
|---|---|
| `plan` | NEW versioned manifest `recovery-multipart-manifest/v1` (O_EXCL; production constants pinned, see `PROD`) |
| `validate` | strict validation of a manifest, by sha256 |
| `copy` | resumable copy: checkpoints, sparse holes, no-replace commit, refusal on any mismatch |
| `verify` | INDEPENDENT re-read of source AND destination (never accepts copy hashes alone) |
| `status` | `copyComplete` and `verificationComplete`, separately |
| `serve` | the only piece meant to run inside the r9 overlay session as `--exec`: a read-only range server that writes no file |

**The manifest pins:**
- the original qcow2 path and identity (dev/ino/size/mtime_ns/ctime_ns);
- the map `70180b22…` (9001 extents, 1,134,426,345,472 mapped bytes);
- the overlay plan `c4e38213…` with **all 30 patch identities** (119,040 bytes);
- the journal `d95d81fc…`;
- the logical size 1,138,166,333,440.

**Layout and coverage:**
- parts of 4 GiB: 265 in total, 0..119 on `root` (515,396,075,520 bytes) and 120..264 on `vm` (622,770,257,920 bytes);
- the exact hole map, including the 3,739,987,968-byte sparse tail;
- per-target `st_dev` + UUID (root 253:0 `1c7c5336…`, vm 253:1 `aaae081c…`) and floors (40 GiB each; host MemAvailable 16 GiB).

**Re-derived on every `copy`/`verify`:** every binding is re-derived from the files (map, plan and patches, journal re-hashed; holes recomputed; original identity). The original's identity is re-checked at every checkpoint.

## The RLIMIT_FSIZE problem and the narrow solution
- **The problem:** r9 `overlay_session.py` gives EVERY child, the `--exec` included, `RLIMIT_FSIZE` = the 64 MiB overlay cap. A copier run as `--exec` could never write a 4 GiB part.
- **Not done:** relaxing the cap.
- **The solution:** the `--exec` is `multipart.py serve`.
  - It opens `RECOVERY_TARGET` O_RDONLY and serves byte ranges over a unix socket in a 0700 directory owned by the copier (peer uid checked on both ends).
  - It **creates no file**, so the cap is irrelevant to it: `RLIMIT_FSIZE` limits regular-file writes, not socket writes.
  - The copier is a separate, unlimited process **outside** the session, and writes the parts.
- **Why this keeps the r9 lifecycle intact:** only the server holds view file descriptors, and r9 cleanup (F1) ends the `--exec` group first and then unmounts. The copier sees EOF, stops, and its committed state is untouched.
- **Tested** with a server under a 16 KiB `RLIMIT_FSIZE` feeding 64 KiB parts, plus the negative control (the copier under the same cap fails).

## NOT implemented / NOT safe yet (explicit)
1. **No reviewed production wrapper exists.**
   - r9's only `--exec` jobs are `root-expose-real.sh` (a GO path, blocked) and `root-diagnostic-expose.sh` (pinned to the MDBX validator).
   - **Needed:** a new, reviewed recovery-overlay revision with a preservation-copy authorization (root-written request bound to this manifest sha, plan, journal) whose only `--exec` is `multipart.py serve` pinned by sha256, started after the copier listens.
   - **None is invented here.** `copy`/`verify` of a production manifest REFUSE a plain `--source-file`.
2. **Capacity:** with no target space today, real admission refuses (full per-target reservation plus the 40 GiB floor).
3. **The production plan** needs root-chosen dedicated empty target dirs on `/` and `/vm`, reviewed before use. The root fs UUID pin comes from a read-only `findmnt -T /` (1746); root should confirm it.
4. **Resume cost:** every resume re-hashes ALL committed parts of the selected range (never trusts them). Use `--parts` to bound one run.
5. **Data authenticity** is out of scope (data blocks are not journaled). Verification proves destination == the source VIEW at verification time, nothing more.
6. **Verify independence:** verification should run in a SEPARATE exposure session (a second `serve`), not the copy session. The code re-reads everything either way.

## Root
```
bash jobs/q-exit-status.sh rmp-r1-tests 512 unshare -Urn bash recovery-multipart-stage/r1/jobs/tests.sh      # expect "## PASS (18)"
```
