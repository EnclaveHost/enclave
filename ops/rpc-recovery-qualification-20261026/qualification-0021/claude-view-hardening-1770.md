# multipart-validation-view-stage/r6: review 1766 hardening (1770). FROZEN, NOT RUN, NOT PASS

**Status:** source only.
- **Executed by me:** `ast`, `bash -n` and sha256.
- **Not done by me:** tests, live I/O, process inspection or commits.
- **Preserved (SUMS re-verified OK):** view r1–r5 (r5 `85f503ae…`, root 1768 actual 10/10 PASS) and recovery-multipart r3 (`fcd8e097…`). The live preserver is not touched.
- **No lifecycle code.**

## Stage `multipart-validation-view-stage/r6/`, SHA256SUMS `18bab7be1a604699ec7e97436b30efbfc6159eecb46a1cd06fc3297fcf091ed7`
| file | sha256 | vs r5 |
|---|---|---|
| `view_descriptor.py` | `23370c97…` | unchanged (= r1/r3) |
| `tests/test_view_descriptor.py` | `80f7b7ec…` | unchanged (5) |
| `production_import.py` (341 lines) | `4d48f74ea0360db6b264fcef97750a5c83e3ba5f8ef47260864b93e940b1b2dc` | the changes below |
| `tests/test_production_import.py` | `8f23524a3e1d0d7d3607406a33fce648ae1376626022115248524ff888be93ac` | 5 → 8 |
| `jobs/tests.sh` | `625da628…` | expects 5 + 8 |
| `jobs/pins.sh` / `jobs/root-view-import.sh` | `7cd1850b…` / `89746f60…` | paths r6 |
| `README.md` / `refs/…vmdk.c` | `dec8588d…` / `75dd58a2…` | |

## Review 1766 findings: what was done
- **P2-1a, fd access mode:** `check-held` now examines EVERY fd of the PID.
  - For each fd whose (dev, ino) is a bound part or the descriptor, it reads `/proc/PID/fdinfo/N` `flags:`.
  - It refuses unless `flags & O_ACCMODE == O_RDONLY`; an unreadable fdinfo for a bound fd also refuses.
  - Possession of every bound inode and the descriptor is still required, bracketed by two rechecks.
- **P2-1 b/c (PID identity, post-use recheck):** left to the future lifecycle, as the review asks: a pidfd or start-time child binding, `check-held` before `--exec`, and a mandatory `recheck` after use.
- **P3-1, kind:** `recheck`, `check-held` and `opts` take `--expect-kind` (default **production**), compared with the receipt's kind in `load_view`. The fixtures name `fixture` explicitly.
- **P3-2, tests:** the new negatives are listed in the next section.
- **P3-3, claim narrowed and cleanup added:**
  - no view dir exists until every check has passed;
  - a write failure afterwards unlinks our own `receipt.json`/`view.vmdk` and removes the dir (best effort);
  - any leftover dir has no receipt, so `load_view` refuses it.
- **L2 (production only; does not change the live r3 preserver):** `qualified_records` requires every commit record binding and **every** verify record binding to be exactly the session binding that r3 `orchestrate.py` (`Provenance.binding`) writes. It checks:
  - the 17-key set: `kind`, `sessionId`, `sessionRunDir`, `sessionPid`, `sessionStartTime`, `serverPid`, `serverStartTime`, `target`, `targetIdentity`, `mntId`, `planSha256`, `parentPath`, `manifestSha256`, `requestSha256`, `mode`, `overlaySessionSha256`, `multipartSha256`;
  - `manifestSha256` = this manifest; `planSha256` = the manifest's plan; `parentPath` = the manifest's `originalPath` (as orchestrate enforces);
  - `multipartSha256` = the pinned r3 `3159890b…`; `overlaySessionSha256` = the r9 pin `65d45ab7…` (orchestrate `PINS`);
  - `mode` = `copy` for commits and `verify` for verify records (orchestrate `--mode` runs `copy_run` or `verify_run`).

  It runs at import and at every recheck. **It is a last defence against accidentally mixed records, not proof against a malicious same-user writer** (all records are same-user writable).
  - `orchestrateSha256` is bound only in the request, not in the session binding, so it is not checkable here. The request itself is not re-read.

## Tests: expected `Ran 5` (view) + `Ran 8` (import)
**Tests 1–5** are r5's, unchanged except that every view command now passes `--expect-kind fixture`.

6. **`check-held`:**
   - a plain holder process (no QEMU) with all bound files `O_RDONLY` passes;
   - the same holder with part 0 or part 3 opened `O_RDWR` (never written) refuses;
   - the test's own PID refuses;
   - a qemu-nbd of a byte-identical fixture (other inodes) passes for its own view and refuses for ours, while ours still rechecks OK;
   - part identities are unchanged.
7. **Kind:** for `recheck`, `opts` and `check-held`, no flag (default production) gives rc 3, explicit production gives rc 3, and fixture gives rc 0. An unknown kind is a usage error.
8. **Production bindings** (direct calls, because a tiny production manifest cannot pass r3 `check_production`):
   - a realistic 17-key binding is accepted;
   - a changed manifest/plan/parent/multipart/overlay sha, the wrong mode, an extra or missing key, `fixture-file`, `unbound-socket` and `None` are each refused;
   - the real fixture records (fixture-file bindings) are refused;
   - all records rebound to qualified bindings are accepted, and then a verify record with `mode: copy` or a commit with another plan's sha is refused.

## Root
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mvv-r6-tests 256 unshare -Urn bash multipart-validation-view-stage/r6/jobs/tests.sh   # expect "## PASS (5+8)"
```
**PASS needs:** exactly `Ran 5` and `Ran 8`, last line `OK`, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, and the stage and r3 SUMS unchanged. The receipt is retained.

**Production import** (`jobs/root-view-import.sh MANIFEST MANIFEST_SHA256 [hash]`) stays gated: it needs a passing r6 receipt and an r3 status with all 265 parts verified in CONFIRMED sessions. It now also refuses unless the L2 bindings check passes.

## Limits
- **L2 for production is fixture-proven only through direct function calls.** The real production branch, with real orchestrator records, is exercised at the first real import. Any mismatch there refuses; it never passes silently.
- **Detection, not prevention:** parts remain same-user writable on read-write filesystems. Integrity of the reconstructed MDBX is untested: structure, canonical-root and state checks remain required.
- **Positive qemu-nbd `check-held` in tests 1 and 6** now also asserts that QEMU's own fds on the parts are `O_RDONLY`. If QEMU opened any bound file writable, root's run will show it as a FAIL, not a silent pass.
