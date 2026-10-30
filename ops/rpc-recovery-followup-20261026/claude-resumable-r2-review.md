# Read-only review: `resumable-state-recovery-stage/r2/srr2.py` (EARLY; the file is still mutable)

**Reviewed bytes:**
- `r2/srr2.py`, **sha256 `a932ca3719389c9b93ed6b6c7660b3e3609ef559a72978ca2ef86b4ede1b2d40`**, 679 lines, read at **2026-10-26T15:59:39Z** (snapshotted before reading);
- the r1 `units/*` and `README.md` in the same stage, which have **not** been updated for r2;
- r2 has no tests yet (`test/` holds r1's).

**Context:** `logs/claude-resumable-state-review.md`; the retention was stopped by the memory floor at 15:53:59 (`logs/recovery-live-stop-1554-note.txt`).

**Not done:** no edit, test, build, network access or live action. Nothing here is a test result or a qualification. Files 6d writes later may be unread; root resumes explicitly.

## Verdict
The fetch core is now **right in design**:
- ONE bounded chunk to a private temp;
- the final response validated **before** commit;
- `pwrite` at S → `fsync` → atomic `committed.json` (tmp, fsync, rename, directory fsync);
- every start truncates only the own uncommitted tail (`:353-358`);
- pins are durable before the first byte is committed (`:395-399`);
- no `curl -C`.

Extraction now goes to staging with an exact output set and **pinned BLAKE3 before anything is installed**, and a finalize guard exists. That addresses my r1 findings A1, A2, B and G2-G6 **in code**.

**What still blocks a working minimal durable fetch:** the unit/ownership wiring (B1), extraction confinement at the OS level (B2), and the guard actually sitting in front of reth (B3). The rest is small.

## Blockers (minimal fixes)
- **B1. The units do not match r2.**
  - **The mismatch:** `units/enclave-base-state-{fetch,extract}.service` still run r1's `state_recovery.py` as `User=rpcbase`. `srr2.py` requires the work directory and its files to be **owned by uid 0, mode 0700** outside test mode (`expect_uid`, `:112-127`, `:130-136`). It also writes `state-extracted.json` into the root-owned holder root (`:481-482`, `:560`). As written, the r2 phases cannot run under these units.
  - **Minimal fix:** r2 units that run `srr2.py` **as root**, sandboxed:
    - `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes`, `KillMode=control-group`, `MemorySwapMax=0`, `Restart=no`, plus the same `Condition…` lines;
    - **fetch:** `ReadWritePaths=<work dir>` only; `MemoryMax=256M` is plausible (not measured);
    - **extract-stage:** see B2;
    - **install:** `ReadWritePaths=<work dir> /srv/enclave-base-holder/data/db /srv/enclave-base-holder` (for the record).
- **B2. The untrusted tar is not OS-confined while `data/` is writable.**
  - **The issue:** the extractor runs `base snapshot download --datadir <stage> --url file://…` (`:523-528`). That is tar 0.4.46's `archive.unpack` (`extract.rs:126-128`). In one process that may also write `data/db`, a tar symlink or hardlink escape (or a tar-crate bug) could modify `data/` **before** the after-the-fact `tree_fingerprint` check (`:522`, `:529`) notices. The check detects; it does not prevent. Whether tar-rs refuses "symlink then a regular file through it" and outside hardlinks is untested here.
  - **Minimal fix:** split `extract` into two separately sandboxed steps:
    - **(a) `extract-stage`:** a unit or `systemd-run` scope with **`ReadWritePaths=<work dir>` only**, `PrivateNetwork=yes`, and `data/` read-only. An escape then fails with EROFS.
    - **(b) `install`:** the existing staged-set check, BLAKE3, `rename` into `data/db` and the record. It never runs the extractor.
  - The current code already has this boundary at `:533-534`; it only needs to become a process/sandbox boundary.
- **B3. The guard must actually run before every reth start.**
  - **What it does:** `cmd_guard` (`:608-634`) refuses a missing record (no state installed, so reth would re-download segmented and non-durably), foreign files, or changed size/mtime/inode/dev without `retention-complete` (finalize/`init_db`). Correct.
  - **The gap:** it is only effective if `enclave-base-retention.service` runs it, e.g. a reviewed drop-in `ExecStartPre=+/usr/bin/python3 -I …/srr2.py guard …` (root and the activation owner decide). Otherwise any controller start re-enters the delete/redownload path.
  - Also confirm that the installed `retention_guard.py pre` capacity rule admits the run while the kept 761 GB archive exists (README item 4).

## Should fix (small)
- **S1. Malformed headers crash the process.** `int(h['content-length'])` (`:290`) raises `ValueError` on a malformed or duplicated header (`parse_headers` merges duplicates with ", ", `:247-248`). That is uncaught (only `Refuse`/`OSError` are handled, `:671-675`): a traceback with exit 1 and no classified refusal. Nothing is committed, so it is safe, but it should be `stop`.
- **S2. The first object identity is whatever chunk 0 returns** (`:395-399`). `--expect-etag` is optional (`:658`). Root should supply the reviewed strong ETag (from a separately reviewed response) to the live fetch, so the pin is reviewed rather than first-come.
- **S3. Ownership of a created `data/db`.** `os.makedirs(data_db)` as root (`:541`) would create a root-owned `db/` if it were absent, which reth (as rpcbase) cannot use. Create it with the datadir's uid/gid, or refuse if it is absent. Today it exists, owned by rpcbase.
- **S4. Orphan curl.** After a SIGKILL of the parent, curl dies on EPIPE (its stdout is our pipe), and the unit's `KillMode=control-group` covers unit runs. For manual runs, add `preexec_fn` with `prctl(PR_SET_PDEATHSIG, SIGKILL)` (or document unit-only use). Leftover header/chunk files are already discarded at start (`:336-337`).
- **S5. BLAKE3 tool check-then-exec** (`:445-449`): it hashes the path and then executes the path. Low risk under a root 0700 tree. To close it, copy the verified bytes into the private work dir (0500) and execute that copy.

## Verified correct in this snapshot (source reading only)
- **Validation before commit** (`:255-294`):
  - redirects anywhere in the chain stop;
  - 1xx blocks are skipped;
  - only `206`;
  - identity encoding;
  - a **strong** ETag, equal to the pin, and Last-Modified equal to the pin;
  - an exact `Content-Range S-E/N`;
  - `Content-Length = E-S+1`;
  - `got == E-S+1` and curl rc 0, otherwise transient;
  - over-length is killed and stopped (`:314-315`, `:380-381`).
- **curl hardening** (`:299-306`): `-q`, no `~/.curlrc`, `--noproxy '*'`, a clean environment, `--http1.1`, `--max-redirs 0`, `--proto =https`, `--max-filesize`, time and stall bounds.
- **Crash points:**
  - a kill mid-chunk or before the `pwrite` loses only the chunk;
  - a kill after the `pwrite`, before the commit, is truncated back at the next start;
  - a kill after the commit loses nothing;
  - SIGTERM with a valid chunk commits it, then exits 143 (`:382-384`, `:363-365`).
- **Ownership:** `O_NOFOLLOW` + `fstat` (regular, owner, no group/other write, `nlink == 1`) on every work file; the work directory is checked with `lstat`; an archive without `committed.json` is refused; a shorter-than-committed archive is refused rather than "repaired".
- **Phase exclusion is mandatory** (the systemctl check can be skipped only with `--test-mode`), plus a `/proc` scan for processes using the archive or datadir, or the base binary; re-checked every 16 chunks.
- **Capacity:** archive remainder + extracted size + remaining history + reserve, on the datadir filesystem. Nothing is deleted to make room.
- **Install:**
  - staging must be exactly the declared outputs (regular, `nlink 1`, sizes);
  - BLAKE3 equals the manifest before any rename;
  - targets must be absent;
  - an `install-inprogress` record precedes the renames, and `resume-install` re-verifies the remainder;
  - the record carries size/mtime/inode/dev.
- **Nothing deletes the archive.**

## Accepted limits (documented, not blockers)
- **No per-chunk digest exists in the manifest.** Transport checks only prevent splicing. Integrity is the final BLAKE3. A mismatch cannot be localised, so the fallback is a full re-fetch.
- **The old reth `.download-cache/state.tar.zst.part`** (sparse, about 4.3 GB allocated) is preserved as evidence and not used (root's note).

## Minimum tests before live use (actual curl + a real local HTTP server; exact counts reported, nothing fudged)
- **Kill points:** SIGKILL at `mid-chunk`, `before-pwrite`, `after-pwrite` (hooks `:50-52`), then resume; the final archive must be byte-identical to the served object.
- **Server misbehaviour:** 200, 3xx, gzip encoding, weak ETag, ETag/Last-Modified change, a wrong range or total, a short body (curl 18), an over-long body, a malformed Content-Length (S1).
- **Ownership:** a symlinked or non-root work file or directory, a held lock, a busy datadir.
- **Extraction (stub tar under the B2 sandbox):** `../`, an absolute path, a symlink followed by a write through it, an outside hardlink, a device node, an extra or missing file, a wrong size, a wrong BLAKE3. Each must leave `data/` untouched and install nothing.
- **Guard:** no record; a changed mtime/inode with no marker; an extra `db/` file; each refuses.

## Addendum 2026-10-26T16:03:02Z (still read-only; no tests run)
**`srr2.py` changed after the snapshot:** it is now sha256 `eae537dc555748bf89c9c3c116c64dffd7f89bbc4de72196a41a09e67fc47064`, 684 lines. The diff against the reviewed bytes has two hunks, both improvements:
- `cmd_fetch` refuses an archive path that is a symlink or not a regular file (`lstat`). This adds to the `O_NOFOLLOW` open.
- `cmd_extract` turns a missing `fetch-complete.json`/`committed.json` into `Refuse(2)` instead of a traceback.

Line numbers above refer to the snapshot: add +2 after line 337 and +5 after line 492. No finding above changes.

**Newly seen, read once:** `r2/controller/srr2-phase-controller.sh` (8,953 B). `r2/test/*` exists but is **not reviewed**.
- **What is good:**
  - it refuses while any retention controller, the retention unit, the holder or the other phase is running;
  - the holder must stay disabled;
  - it owns only a NEW InvocationID, and `stop` happens only after re-reading that the unit still runs ours;
  - deadline, signal and the host MemAvailable watchdog stop only our invocation;
  - the floor can only be raised;
  - guard is a read-only phase.
- **B1 is still open:** the controller starts `enclave-base-state-fetch-r2.service`/`-extract-r2.service` and runs `$REMOTE/run-guard.sh` (`/opt/enclave-rpc/state-recovery-r2`). **None of these exist in the stage** (glob: no `*-r2*` or `run-guard*` files). Until they exist and are reviewed, the controller cannot run a phase.
- **B3 is only partly met:** `--phase=guard` is a separate gate, and the retention start is "a separate controller". So there is a gap between guard and start, and a retention start that skips this phase is not gated. The `ExecStartPre` guard in the retention unit (drop-in) is still the minimal robust fix. The controller phase can remain as an early check.
- **Small:** the r2 fetch unit's `TimeoutStopSec` must be greater than one chunk's worst-case `pwrite`+`fsync`+commit time. Otherwise a stop at the deadline or the memory floor SIGKILLs a commit in progress. That is safe (the tail is truncated next start) but wastes the chunk. The controller's `STOP_TO=240` should exceed it as well.
