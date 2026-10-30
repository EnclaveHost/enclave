# multipart-validation-view-stage/r4: production view import from recovery-multipart r3 records
(PREPARED by Claude 1759; source + fixture tests only; NOTHING run by Claude. Status: PENDING root tests, NOT PASS. Report:
../../logs/claude-multipart-view-production-1759.md)

**r4 = r3, unchanged, + `production_import.py` + `tests/test_production_import.py` + jobs.**
- **Unchanged runtime:** `view_descriptor.py` is byte-identical to r1/r3 (`23370c97…`), and r3's 5 tests are unchanged (`80f7b7ec…`).
- **The importer reuses the PINNED recovery-multipart r3 `multipart.py`** (`3159890b…`, stage SUMS `fcd8e097…`), compiled from exactly the hashed bytes: `load_manifest`/`validate_manifest`/`check_production`, `load_record`, `status` (production counts only CONFIRMED sessions).

**The importer refuses (rc 3, nothing written) unless all of these hold:**
- the manifest sha256 matches and its kind is the one expected (default **production**);
- r3 recorded state is complete and verified, with stale, unconfirmed, invalid and failed all empty, evaluated twice with identical results;
- every part is a single-link regular file whose current identity equals its commit record, on its target's MAJ:MIN, a multiple of 512 bytes, with distinct inodes.

**Protection does NOT come from file permissions.** Parts are NEVER chmod'ed or opened for writing (their ctime is bound by the r3 records), and they stay on read-write filesystems. What protects the view:
- `read-only=on` in the image-opts, with `qemu-io -r` / `qemu-nbd --read-only`;
- inode binding: `recheck` (manifest + r3 status + every identity and record byte again; `--hash` = full re-hash against the recorded sha256) and `check-held` (QEMU holds exactly those inodes).

An in-place write is detected (ctime) at the next recheck; it is not prevented.

**Tests:** 5 + 5. Root runs:
`bash jobs/q-exit-status.sh mvv-r4-tests 256 unshare -Urn bash multipart-validation-view-stage/r4/jobs/tests.sh` → `## PASS (5+5)`.

**Production (gated):** `jobs/root-view-import.sh MANIFEST MANIFEST_SHA256 [hash]`, only after a passing r4 test receipt and an r3 status showing all 265 verified.

**Separate:** exposure to `mdbx_chk` or Reth through a reviewed r9-lifecycle revision (check-held before `--exec`, recheck after), then MDBX structure, canonical-root and state checks. A view is not integrity.

---
**r3 README (unchanged below):**

# r3 content-equivalence fixture

Actual r2 fixtures had one failure: QEMU strict compare rejects different allocation/block-status layouts even when logical content agrees. This revision checks every logical byte through qemu-io against the independent expected bytes, retains the exact virtual-size assertion, and uses qemu-img content comparison without the allocation-layout requirement. Descriptor runtime remains byte-identical. This does not waive any source-data or production check. Actual r3 tests remain pending until the receipt exists.

# r2 fixture corrections

Root ran r1 fixtures: five ran, three failed and a ResourceWarning occurred. This revision leaves the descriptor runtime byte-identical. It corrects the expected directory sort order, closes the test descriptor file, and explicitly opens qemu-io read-only with `-r` rather than conflicting with the read-only block node. Tests remain pending until the actual r2 receipt exists. Production input remains refused.

# multipart-validation-view-stage/r1: read-only single logical file VIEW of multipart parts via a VMDK FLAT-extent descriptor
(PREPARED by Claude 1751; source + tiny fixture tests only. NOTHING run, built or tested by Claude. Status: PENDING root tests, NOT PASS.)
Report: ../../logs/claude-multipart-validation-view-1751.md

## What it is
`view_descriptor.py` (stdlib only) writes, into a NEW 0700 directory, two 0400 files:
- `view.vmdk`: one `RW <sectors> FLAT "<abs path>" 0` line per part, `createType="monolithicFlat"`, CID/parentCID header, no parent;
- `receipt.json`: the parts list (sha256-bound), every part's identity (dev/ino/size/mtime/ctime) and the exact `--image-opts`:
  `driver=vmdk,read-only=on,file.driver=file,file.filename=<view.vmdk>,extents.N.driver=file...`.
  Every extent is forced to the raw `file` driver, so part bytes are never format-probed.

Nothing else is ever written: no part, no original, no concatenated copy.

| command | does |
|---|---|
| `build --parts P --out-dir NEW` | strict input, full sha256 of every part with identity stable across the read, all identities re-checked after all reads, then writes the two files |
| `recheck --view-dir D [--hash]` | descriptor/receipt/opts consistency plus every part identity unchanged (`--hash`: full re-hash) |
| `check-held --view-dir D --pid P` | the running QEMU (our child) holds EXACTLY the verified part inodes and the descriptor (closes the verify→open race) |
| `opts --view-dir D` | recheck, then print the image-opts |

## Proven QEMU facts (`refs/qemu-v11.1.2-block-vmdk.c`, sha256 `75dd58a2…`; official gitlab v11.1.2 = installed 11.1.2-1)
- **FLAT extents have no per-extent or total sector cap;** `VMDK_EXTENT_MAX_SECTORS` applies to sparse growth only. 265 × 4 GiB = 1.14 TB is representable; it is unmeasured here.
- **Absolute extent paths are opened as given,** on any filesystem.
- **Path limit:** ≤ 511 bytes, no `"`, CR or LF (`sscanf %511[^\n\r"]`).
- **Descriptor size:** ≤ 1 MiB − 1.
- **Non-RW lines are SILENTLY skipped**, which gives a shorter disk. Every line here is RW; writes are impossible because of `read-only=on`, and parts must have no write bits.
- **`parentFileNameHint` anywhere** in the descriptor opens a backing file (strstr). It is refused in every path and checked again in the output.
- **Part file sizes are NOT checked at open,** and reads past an extent's EOF return zeros. Integrity can never come from the descriptor; it comes from size + sha256 + identity rechecks + `check-held` (test 4 demonstrates the zero-fill).
- **Sizes:** extents are whole 512-byte sectors, so every part (including a short final part) must be a multiple of 512.

## Input (r1): generic explicit parts, FIXTURE ONLY
`{"format":"multipart-view-parts/v1","kind":"fixture","logicalSize":N,"parts":[{"index","path","size","sha256"},…]}`
- **Refused:** `kind` other than `fixture`, and any `recovery-multipart*` manifest. **Production views are REFUSED** until the final recovery-multipart r2 schema is accepted and a reviewed adapter binds to it.
- **The r1/r2 multipart stages are not touched.**

## Tests (5, `tests/test_view_descriptor.py`; tiny parts in two dirs; NO MDBX file is involved yet)
1. **Boundary reads:** qemu-io single reads straddle each of the three FLAT boundaries, one read spans two boundaries, and the short final part (3 sectors) is read; all are compared with the known bytes. Also `qemu-img info` virtual size, `qemu-img compare` against the expected raw, and `recheck --hash`.
2. **No probing:** a part beginning with a qcow2 header is served raw. An `extents.9.driver` option for a non-existent extent is refused, which shows the options are consumed.
3. **Refusals (rc 3, no output dir created):** missing, corrupt (sha), wrong size, non-512 final part, logical size mismatch, index gap, relative path, comma, quote, `parentFileNameHint`, more than 511 bytes, symlink component, writable part, hardlink (same inode), duplicate path, production kind, r1 manifest; an existing out dir is also refused.
4. **Truncation hazard:** after a part is truncated, QEMU reads zeros; `recheck`/`opts` refuse.
5. **`check-held`:** passes for the view's own qemu-nbd. It refuses a server of byte-identical copies (other inodes) while `recheck` passes. It refuses after a part path is swapped to a new inode.

## Root
```
bash jobs/q-exit-status.sh mvv-r1-tests 256 unshare -Urn bash multipart-validation-view-stage/r1/jobs/tests.sh   # expect "## PASS (5)"
```
**The receipt is retained** at `runs/tests-*/receipt.json` with stdout and stderr. PASS requires all of: Ran 5, last line OK, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0.

## NOT done / separate integration requirement
- **No lifecycle code here.** Exposure for `mdbx_chk` or a Reth helper should reuse `recovery-overlay-stage/r9` (`17b5528f…`): pinned `qemu-nbd --read-only --shared=1` + `nbdfuse -r -C 1`, bounded `--exec`, ordered cleanup. That needs a reviewed revision that:
  - accepts this view's image-opts instead of its qcow2 overlay;
  - runs `check-held` on its qemu-nbd before `--exec`, and `recheck` after;
  - replaces r9's read-only-parent-mount gate. The parts live on read-write `/` and `/vm`, so their protection is the 0444/root ownership + identity + `check-held`.
- **Production timing:** a production `build` re-reads 1.14 TB to hash. That is not a light step, and it is root's to schedule.
- **What a view proves:** the logical bytes equal the parts listed at build time. It does NOT prove MDBX structure, canonical roots, state or recovery.
