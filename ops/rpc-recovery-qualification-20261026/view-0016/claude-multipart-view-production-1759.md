# multipart-validation-view-stage/r4: production view import from recovery-multipart r3 records (1759). FROZEN, NOT RUN, NOT PASS

**Status:** this is fixture proof only, pending root's queued tests.
- **Executed by me:** `ast`, `bash -n` and sha256 only.
- **Not done by me:** tests, builds, copies, original I/O, or any read of the live part-0 copy session, its paths or its processes.
- **Untouched, SUMS re-verified OK:** view r1, r2, r3 and `recovery-multipart-stage/r3` (`fcd8e097…`).
- **No commits or pushes.**

## Stage `multipart-validation-view-stage/r4/`, SHA256SUMS `52e307fafac69947f52e3d18747ff813b12552871c9373a146a869bdc432408e`
| file | sha256 | note |
|---|---|---|
| `view_descriptor.py` | `23370c97…` | **byte-identical to r1/r3** (qualified runtime) |
| `tests/test_view_descriptor.py` | `80f7b7ec…` | = r3 (5 tests, root actual PASS on r3) |
| `production_import.py` | `c82aea96e341e2324f11e04c0de0053da888e069645603c6dee11b09cd2ed881` | new |
| `tests/test_production_import.py` | `ac9141cfbddb8b547d389c19b0a58e32fc61804103d96ec4601e92da5b72eb09` | new, 5 tests |
| `jobs/tests.sh` | `dbcdf231…` | two suites, r2-pattern receipt |
| `jobs/pins.sh` | `3e587f7b…` | QEMU pins + recovery-multipart r3 SUMS `fcd8e097…` |
| `jobs/root-view-import.sh` | `012cb7a1…` | production, gated |
| `README.md` | `63d62419…` | |
| `refs/qemu-v11.1.2-block-vmdk.c` | `75dd58a2…` | |

## Design: reuse, no new framework or lifecycle
**`production_import.py` reuses r3's own logic.** It loads the **pinned r3 `multipart.py`** (`3159890b…`), compiled from exactly the hashed bytes, and uses:
- `load_manifest` → `validate_manifest` + `check_production` (every PROD pin: original, map, plan, journal, 265 × 4 GiB, targets root/vm by MAJ:MIN + UUID);
- `load_record`;
- `status` (production bindings count only with a **CONFIRMED** session record).

**The view itself** is built with the unchanged `view_descriptor` functions.

**`import` fails closed (rc 3, nothing written) unless all of these hold:**
- the manifest sha256 matches and its kind matches `--expect-kind` (default **production**);
- r3 status shows `copyComplete`, `verificationCompleteRecorded`, all counts equal to `parts`, and stale, unconfirmed, invalid and failed all empty, **evaluated twice** with identical results;
- every part is a regular, single-link file of its exact length (a multiple of 512) on its target's recorded MAJ:MIN, whose **current dev/ino/size/mtime/ctime/nlink equals its commit record's `destIdentity`**, with distinct inodes and a descriptor-safe absolute path;
- the parts cover the logical size.

**The receipt pins:**
- the manifest path and sha, and the r3 `multipart.py` sha;
- the status snapshot;
- per part: path, size, the recorded `logicalSha256`, `destIdentity`, the commit-record **bytes** sha and the target;
- the descriptor sha and image-opts, and `partsChmodded: false`.

**No chmod and no immutability claim.** Parts are never chmod'ed, opened for writing or moved; their ctime is bound by the r3 records.
- **What protects the view:** QEMU read-only opens (`driver=vmdk,read-only=on,…,extents.N.driver=file`; `qemu-io -r` / `qemu-nbd --read-only`) and **inode binding**:
  - `recheck`: the manifest bytes, r3 status, every identity and record byte again; `--hash` is a full re-hash against the recorded sha256;
  - `check-held`: the QEMU PID holds exactly the bound inodes and the descriptor, rechecked before and after.
- **What it does not do:** the filesystems stay read-write. An in-place write is **detected** (ctime and identity) at the next recheck; it is not prevented.

## Tests (expected counts: view_descriptor 5 + production_import 5)
**Fixtures are real r3 records.** Each one is planned, copied and verified by the **pinned r3 CLI** (fixture kind, `--source-file`) on r3's own 204,800-byte layout: 3 × 64 KiB parts plus an all-hole 8 KiB tail part, in two target dirs. Allocations are tiny.

1. **Positive:**
   - the receipt pins the values above;
   - qemu-io `-r` reads straddling all 3 FLAT boundaries, plus the full logical read, equal the source bytes; `qemu-img compare` is identical;
   - `recheck --hash` passes;
   - write attempts through the view (with and without `-r`) leave the bytes unchanged;
   - `check-held` on qemu-nbd passes;
   - part inode, mode and ctime are **unchanged**.
2. **Manifest gates:** a fixture manifest is refused as production (the default); a kind-edited "production" manifest is refused by r3 `check_production`; wrong sha; generic r1 parts file; an existing out dir.
3. **Partial state:** copy 0–2 with verify 0–2; full copy with verify 0–1; full copy and no verify; plan only. All are refused.
4. **Records:** a verify record rebound to an **unconfirmed** session, an added **FAIL** verify record, a **malformed** verify record (extra key) and a **mismatched** commit record (`logicalSha256`) are all refused. A positive control passes after the restores.
5. **Stale parts:**
   - before import: a byte-identical **replacement** inode, a `utime` touch, a hard link — all refused;
   - after import, a one-byte **in-place** change makes `recheck`, `opts` and `check-held` (with a running server) all refuse.

## Root invocation
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mvv-r4-tests 256 unshare -Urn bash multipart-validation-view-stage/r4/jobs/tests.sh   # expect "## PASS (5+5)"
```
**PASS needs, per suite:** exactly `Ran 5 tests`, last stderr line `OK`, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, and rc 0. The stage and r3 SUMS must also be unchanged. The receipt is retained at `runs/tests-*/receipt.json`.

**Production (only after that PASS AND an r3 status with all 265 parts verified in CONFIRMED sessions):**
```
bash jobs/q-exit-status.sh mvv-r4-import 256 bash multipart-validation-view-stage/r4/jobs/root-view-import.sh MANIFEST MANIFEST_SHA256 [hash]
```
- **Who runs it:** the user that owns the r3 target dirs (r3 `open_dir` requires it), with exactly the manifest and sha of the r3 production runs.
- **What it reads:** records + lstat only. `hash` triggers a full 1.14 TB re-read, which root schedules.
- **What it writes:** only `r4/runs/view-*`.

## Limits
- **Fixture proof only.** A real 265-part import, QEMU with 265 extents (266 fds) and production timing are unmeasured.
- **Recorded state, not fresh measurement:** the import trusts r3's recorded **verify** results, which were fresh at their own time, bound to current identities. Identity binding detects later changes; only `--hash` re-measures content.
- **Same-user writes:** the parts stay writable by their owner and root. Only detection is claimed.
- **Separate integration:** exposure for `mdbx_chk` / Reth needs a reviewed r9-lifecycle revision (check-held before `--exec`, recheck after). MDBX structure, canonical-root and state checks remain required.
- **A view is not integrity of the reconstructed file.**
