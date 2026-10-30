# recovery-multipart-stage/r1: resumable, independently verified multipart preservation copy (1746). Source + tiny tests only

**Not done by me:** no build, no test run, no production read or copy, no VM, USB, mount, large allocation or edit of any existing stage.
- **Read only:** small local metadata, i.e. the sources and READMEs of recovery-overlay r9, the pinned map/plan JSON structure, and two read-only `findmnt`/`stat` metadata queries for the device pins.
- **recovery-overlay-stage/r9 is unchanged** (SUMS verified).

**Status: PENDING.** Root runs the 18 tests. A production run is NOT possible from this stage (no reviewed wrapper; no capacity; no go-ahead).

## Stage: `recovery-multipart-stage/r1`, FROZEN
**`SHA256SUMS` = `59f7ec419a4033f4a0d69b39c7bbfc15e5991d5a540f51a3072b79fd15b6f9a9`.**

| file | sha256 |
|---|---|
| `multipart.py` | `e248ee9992c93a70d67a528acd0e2650b3a63605cfea8d24f0fe05c562c658c7` |
| `tests/test_multipart.py` (18) | `1084e16c623cce43a85860f53717cca219aabd2867534ff253ee57fff2b3eb34` |
| `jobs/tests.sh` | `9047e9bf0a82077bd4914a8c6f48a7a8ed3c448c8fac00a0eda9a7d9301ccc60` |
| `README.md` | `4f9eed5e80e5bc98bc2d142b090911737c71b648b2d1247864484f66643271b4` |

## Integration finding: r9's RLIMIT_FSIZE and the narrow solution
- **The finding:** `overlay_session.py` `limits(fsize)` (`:68-77`) applies `RLIMIT_FSIZE` = the cap (64 MiB) to **every** child, including the `--exec` (`:429-433`; stdout → `exec.out`, cwd = run dir, `close_fds`, `PDEATHSIG`). A copier run as `--exec` would fail at 64 MiB (EFBIG/SIGXFSZ).
- **The solution keeps the cap and every read-only check:**
  - **The `--exec` = `multipart.py serve`:** it opens `RECOVERY_TARGET` O_RDONLY|O_NOFOLLOW, checks that it is a regular file of the pinned size, `fchdir`s into the copier's 0700 socket dir, connects to `mp.sock` (relative, so no 108-byte limit), checks the peer uid, and serves `R off len` (≤ 8 MiB, in range, size re-checked) as `D off len` + bytes.
  - **It never creates a file.** `RLIMIT_FSIZE` limits regular-file growth only, so socket writes are unaffected.
  - **The copier** (outside the session, unlimited) writes the parts.
- **Lifecycle:** the server is the only holder of view fds, and r9's F1 cleanup ends the exec group first, so unmounts stay clean. The copier gets EOF and stops; committed state is unaffected.
- **Socket visibility:** the copier binds `mp.sock.new`, listens, and only then renames it to `mp.sock`, so the socket is visible only once it is listening.
- **Missing, and NOT invented:** a reviewed production wrapper. r9's `root-expose-real.sh` is the GO path (blocked by history), and `root-diagnostic-expose.sh` pins `--exec` to the MDBX validator.
  - **Needed:** a new reviewed recovery-overlay revision with a preservation-copy authorization (root-written request bound to the manifest sha, plan `c4e38213…`, journal `d95d81fc…`) whose only `--exec` is the sha-pinned `multipart.py serve`, started after the copier listens. That wrapper would run one session for copy and a **separate** session for verify.
  - **Until then:** a production manifest REFUSES `--source-file` (only `--source-socket-dir`).

## Pipeline (what is implemented)
**Manifest (`plan`, `recovery-multipart-manifest/v1`; written O_EXCL 0600, never replaced). It pins:**
- the source: the original qcow2 path and identity; map path + sha (re-parsed: ordered, non-overlapping, no unwritten extents, extent count, mapped bytes); overlay plan path + sha (format, bound to the map sha, journal sha, size, extent count), **all patch identities** and patch bytes; journal path + sha;
- the logical size and block size; the global hole map and its sha;
- targets (dir, `majmin`, UUID, floor);
- part / chunk / checkpoint sizes and the host memory floor;
- parts (index, offset, length, target, file `part-NNNN.bin`, per-part holes, data bytes).

**Production (`--production`) pins everything:**
- paths/shas, 9001 extents, 1,134,426,345,472 mapped bytes, 30 patches / 119,040 bytes;
- 4 GiB parts × 265; root = parts 0..119 (515,396,075,520 bytes), vm = parts 120..264 (622,770,257,920 bytes);
- floors 40 GiB per target and 16 GiB host MemAvailable; 8 MiB chunks, 256 MiB checkpoints;
- targets root 253:0 / `1c7c5336-9d52-4858-828a-823c31189c59` and vm 253:1 / `aaae081c-f829-4484-a50f-a9bbb87d31f9`;
- different filesystems, neither the source's, neither on USB (sysfs walk through `slaves/`; an unknown device refuses).

**Validation (`validate_manifest`):**
- exact keys at every level;
- parts in index order, contiguous from 0, non-overlapping, only the last part short, the total equal to the logical size;
- per-part holes exactly the intersection of the global hole map; hole-map sha and mapped-byte consistency;
- known targets, unique files;
- for production, every pin.

**Bindings re-derived on every `copy`/`verify` (never trusted from the manifest):** the original's identity, the map/plan/journal re-hashed, holes and patches recomputed and compared.

**Copy, per part:**
- **Admission first, before anything is written:** for every target, the filesystem `st_dev` (plus UUID/USB in production), dir ownership/mode, a no-symlink ancestry, an empty-or-ours marker, a free-space reservation of every uncommitted part's full length plus the floor (no compression or sparse credit), and the memory floor.
- **Then:** an `flock` per target (concurrency 1), a checkpoint FIRST, then a NEW temp (O_EXCL|O_NOFOLLOW, 0600).
- **Holes:** must read zero, otherwise REFUSE (map/source disagree), and are left sparse.
- **Data** is written with `pwrite`.
- **Every 256 MiB:** an `fsync`, an atomic checkpoint (`prefixSha256`), the original identity, and the floors.
- **At the end:** `ftruncate` to the length (sparse tail), `fsync`, a full re-read of the temp equal to the hash, then `link` to the final name **without replace**, unlink the temp, a dir `fsync`, and an atomic commit record (no-replace link).
- **Resume never trusts an existing file:**
  - a committed part is fully re-hashed against its record;
  - "data linked, no record" is adopted only if file == source re-read;
  - a partial is accepted only if its prefix == the checkpoint sha (then truncated to the committed size);
  - a temp without a checkpoint is refused.
- **Any mismatch → rc 4, every file kept.**

**Cancellation:**
- SIGTERM/SIGINT/SIGHUP raise at a safe point, and are deferred during state writes (`critical()`);
- the state is always the last fsynced checkpoint plus committed parts;
- `--max-bytes` stops cleanly (rc 5);
- no process is killed and no daemon is started.

**Verify:**
- per part, a fresh read of the SOURCE and the DESTINATION, compared byte by byte; hole zeros; size;
- both hashes must equal each other **and** the copy record;
- the original identity before and after;
- a NEW per-run verify record (PASS/FAIL, never overwritten);
- **no source → refused.**

**Status:** `copyComplete` and `verificationComplete` separately. Any FAIL record blocks `verificationComplete`. There are no RAID/production booleans.

## Tests: 18 (`tests/test_multipart.py`; tiny fixtures, two target dirs; expectations from the fixture bytes, never from the tool)
1. **Positive:** two targets, copy then independent verify.
   - layout and hole map checked by hand;
   - `copyComplete` true / `verificationComplete` false after the copy only;
   - the concatenation equals the independent source sha256;
   - the pure-hole tail part equals zeros; modes 0600.
2. **Budget stop inside a part:** rc 5; the checkpoint prefix equals the source bytes; the resume completes byte-exact.
3. **SIGTERM mid-part** with a stalling test server: rc 5 with a checkpoint ≥ 16 KiB and no record; then resume and verify.
4. **A corrupt destination** is detected by verify **and** resume (rc 4); the file is kept and byte-identical.
5. **Verify cannot accept copy hashes alone:**
   - a tampered part plus a forged consistent record → FAIL;
   - a source changed after the copy → FAIL;
   - a missing source → refused, not verified.
6. **A truncated part:** refused, kept, `copyComplete` false.
7. **A non-zero source byte in a map hole** (sparse tail): refused, no record.
8. **Write failure** (`RLIMIT_FSIZE` with EFBIG), then resume and verify.
9. **Integration:** `serve` under a 16 KiB `RLIMIT_FSIZE` feeds copy and verify of 64 KiB parts; the negative control (the copier under the cap) fails.
10. **Changed bindings** (map, journal, patch identities, original mtime, a manifest edit): refused, nothing created.
11. **Manifest coverage:** gap, overlap, duplicate, missing last part, short middle part, dropped hole, moved global hole, extra key (`productionReady`), unknown target, path-escaping file name → all refused.
12. **A symlinked target and a symlinked ancestor** are refused.
13. **A part replaced by a symlink** is refused and the outside file is untouched; a foreign non-empty target dir is refused and left alone.
14. **Wrong filesystem, capacity floor and memory floor** are refused before anything is written.
15. **Concurrency 1:** a held target lock gives a refusal.
16. **Production pins:** the 265/120 split arithmetic; `--production` on non-pinned inputs is refused; a manifest relabelled production is refused.
17. **USB detection** on a synthetic sysfs (direct USB, dm over USB, nvme, an unknown device).
18. **The findmnt UUID parser** fails closed.

## Root
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh rmp-r1-tests 512 unshare -Urn bash recovery-multipart-stage/r1/jobs/tests.sh     # expect "## PASS (18)"
```
- **Before any real use:**
  - the reviewed preservation wrapper (above);
  - root-created, empty, owner-only target dirs on `/` and `/vm`;
  - confirmation of the root-fs UUID pin;
  - capacity for 120 × 4 GiB + 40 GiB on `/` and 145 × 4 GiB + 40 GiB on `/vm`.

## Explicitly NOT safe / NOT done
- **No production wrapper or authorization format** (deliberately not invented).
- **Disk-full** is tested via EFBIG (`RLIMIT_FSIZE`), not a real ENOSPC; the runtime free-space floor is checked at every checkpoint. An `fsync` failure goes through the same OSError → rc 4 path but is not separately faked.
- **Resume cost:** a resume re-hashes all committed parts in the selected range (up to about 1.1 TB); `--parts` bounds it.
- **Sparse files:** the sparseness of the output files is not asserted (filesystem dependent); the logical content and the hole map are.
- **Not proven:** data authenticity, recovery, or intactness of any kind. Verification proves only destination == the source view at that time.
