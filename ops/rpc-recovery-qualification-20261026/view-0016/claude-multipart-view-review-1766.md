# 1766: source-only review of the frozen multipart-validation-view-stage/r4 production import (NOT a PASS)

**Scope:** reading only.
- **What I executed:** `sha256sum -c` of the r4 SUMS; hashes of the r3 view runtime and of the r3 recovery-multipart `multipart.py`; a `diff` of r3 `multipart.py` against the r2 core I reviewed in 1750.
- **Not done:** edits, tests, builds, copies, reads of any live part, process inspection, or any look at r3 session or run paths.
- **Tests:** root's 5+5 fixture run is in progress; **nothing here asserts PASS**.

## Exact inputs
| item | sha256 |
|---|---|
| r4 `SHA256SUMS` (all 9 entries verify: OK) | `52e307fafac69947f52e3d18747ff813b12552871c9373a146a869bdc432408e` |
| `production_import.py` (262 lines) | `c82aea96e341e2324f11e04c0de0053da888e069645603c6dee11b09cd2ed881` |
| `tests/test_production_import.py` | `ac9141cfbddb8b547d389c19b0a58e32fc61804103d96ec4601e92da5b72eb09` |
| `jobs/tests.sh` / `jobs/root-view-import.sh` / `jobs/pins.sh` | `dbcdf231…` / `012cb7a1…` / `3e587f7b…` |
| `view_descriptor.py` (unchanged, = r3; qualified 5 PASS earlier) | `23370c97956fb1a4dde30f4a657ca97e89ce452f1a982cfc29c36970113d39e0` |
| pinned recovery-multipart r3 `multipart.py` (r3 SUMS `fcd8e097…`) | `3159890b5bddcb763f578fa87b833931d695f4181dd447395bb40c2dff1c4381` |

**r3 `multipart.py` compared with the r2 core `a88324f6` I reviewed in 1750:** `status()`, `load_record` and `binding_counts`/`session_confirmed` are byte-identical. r3 adds:
- `revalidate_prefix`: a resumed prefix is re-read from the **current** bound source and byte-compared, plus an immutable `resume-<run>.json`. This closes 1750 P1, so a commit binding is truthful;
- exact `--max-bytes`;
- soft deadlines.

## Verdict
**No blocker found in the production import itself.**
- **The import refuses unless r3's recorded state is complete and verified.** It evaluates that state twice, and both evaluations must be identical. "Complete and verified" means all of these:
  - `copyComplete`;
  - `verificationCompleteRecorded`;
  - `partsCommitted == partsVerifiedRecorded == 265`;
  - `stale`, `unconfirmed`, `invalidRecords` and `failedVerification` all empty.
- **Then, for every part,** it checks:
  - the current `lstat` identity equals the commit record's `destIdentity` (dev, ino, size, mtime, ctime, nlink);
  - `nlink == 1` and a regular file;
  - the part is on its target's pinned MAJ:MIN;
  - its length is a multiple of 512;
  - it has a distinct inode.
- **What the view receipt stores:** the sha of each record's bytes. `recheck` re-derives everything (the manifest, r3 status, identities and record bytes) and requires equality.
- **The remaining items** are hardening for use of the view, or documented same-user-writable limitations.

**Acceptance gaps asked about:**
- **Unconfirmed records:** for a production manifest, r3 `status` counts a commit or verify binding only through `session_confirmed` (a CONFIRMED `session-<id>.json` in the same target dir, with an equal binding). `verified` requires a valid PASS whose binding counts, with `measuredAtNs > committedAtNs` and source == destination == record hash. So every imported part has a recorded **fresh PASS from a CONFIRMED session**. A part whose commit session is unconfirmed is accepted only through such a PASS (by design; 1750 P2-a).
  - **No gap.**
- **Stale or replaced parts:**
  - an identity, nlink or size change goes to `stale` in status and is refused by `bound_parts`;
  - a re-recorded part shows up as a changed `recordSha256` at `recheck`;
  - test 5 covers a new inode, a `utime` change, a hard link and an in-place write after import.
  - **No gap.**
- **Source or provenance mismatch:**
  - a record or verify record from another manifest is `invalid`, which blocks import;
  - a FAIL record blocks permanently;
  - resume-prefix provenance is now re-proven (r3).
  - **No gap in code.** The limit is listed under L2.

## Findings (severity + minimal correction)

### P2-1 (before ANY production use of a view; not an import blocker): `check-held` proves possession only, not read-only access or process identity
**Code:** `production_import.cmd_check_held` (217–233) checks that `/proc/PID/fd` contains every bound part inode and the descriptor inode, bracketed by two `recheck`s. Three things are left open:
- **(a) open mode:** it does not check how those fds were opened. A server started from the opts but with a writable mode would pass. Parts stay `0600` on read-write filesystems by design, so `read-only=on` is the **only** write barrier.
- **(b) process identity:** the PID's identity is the caller's responsibility; there is no check that it is our unreaped child.
- **(c) the use window:** writes after the second `recheck` are only *detected* by a later `recheck`.

**Minimal correction:**
- for (a), about 5 lines in `cmd_check_held`: for each fd whose (dev, ino) is bound, read `/proc/PID/fdinfo/N` `flags:` and refuse unless `int(flags, 8) & os.O_ACCMODE == os.O_RDONLY`;
- for (b) and (c), the future r9-lifecycle revision must use pidfd/start-time binding of its own child, run `check-held` before `--exec`, run a **mandatory post-use `recheck`**, and void any result if that recheck fails.

### P3-1 (lifecycle integration): `recheck`/`check-held`/`opts` never re-assert the view's kind
- **The problem:** `--expect-kind production` is enforced at import only. A fixture view (`rec["kind"]=="fixture"`, fixture manifest) passes `opts` and `check-held`, so a production lifecycle handed the wrong view dir would proceed.
- **Correction:** `--expect-kind` (default `production`) on these three commands, compared in `load_view`.

### P3-2 (test coverage; real proof vs design)
- **Production branch of r3 status not exercised by r4:** r4's 5 tests use fixture manifests, where `binding_counts` also accepts the `fixture-file` binding. The production branch (CONFIRMED sessions only) is proven by r3's unit/E2E runs (31 + 7 PASS per pins) and by my source reading, **not by r4**.
  - test 4 "unconfirmed" covers only an unconfirmed **verify** binding under the fixture branch.
- **r4's `cmd_check_held` is a separate copy of the qualified `view_descriptor` one,** and r4 tests only its positive path and a refusal driven by `recheck`.
  - **Minimal addition:** one negative test in which a PID that does not hold the parts (e.g. a qemu-nbd over byte-identical copies, as in view test 5) gives rc 3. Plus the P2-1 flags check if adopted.

### P3-3 (claim precision): "nothing written on refusal"
- **The problem:** if `write_new` fails after `os.mkdir(out)` (ENOSPC/EIO), the process returns rc 3 with a partial view dir left. This is harmless, because `load_view` refuses without a receipt.
- **Correction:** either remove our own new files and dir on that path, or narrow the docstring.

## Documented same-user-writable limitations (accepted design; not blockers)
- **L1. Detection, not prevention:** parts remain `0600` on read-write filesystems. Chmod would change the ctime bound by the r3 records. An in-place write keeps the inode but changes ctime, so it is caught at the next `recheck` (test 5), not prevented.
- **L2. The importer trusts recorded files:**
  - it trusts r3's records, verify records and CONFIRMED session records as written. Provenance (pinned plan, parent, server PID, receipt) was proven at run time by `orchestrate.py` and the r9 receipt, not re-proven at import;
  - all of these files are same-user-writable;
  - `status` does not cross-check a binding's internal `planSha256`/`parentPath` against the manifest pins. Optional hardening: compare them in production.
- **L3. No fresh content read** unless `recheck --hash`, a full 1.14 TB re-read against `logicalSha256` (worth scheduling once before MDBX checks).
- **L4. No locks:** the importer takes no target `flock`. It writes nothing to targets, and an incomplete r3 state (the live r3 copy now holds parts 1..8) is refused, so this is not a gap.

## Future lifecycle integration (not in r4)
- an r9-lifecycle revision with the PID binding, `check-held` before `--exec`, and `recheck` after (P2-1 b/c);
- the fdinfo read-only check (P2-1 a);
- the kind assertion (P3-1);
- then MDBX structure, canonical-root and state checks. **A view is not integrity.**

## Limits of this review
- **Source reading only.** Root's tiny 5+5 fixture run is the evidence and is still pending.
- **Unchecked live state:** no production manifest, record or part was inspected, and I did not look at r3 session or run paths.
