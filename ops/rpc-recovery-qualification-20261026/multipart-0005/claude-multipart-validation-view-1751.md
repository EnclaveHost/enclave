# multipart-validation-view-stage/r1: read-only single logical view of the 265 parts via a VMDK FLAT descriptor (1751). FROZEN, NOT RUN, NOT PASS

**Status:** source and tiny fixture tests are prepared. **Root has not run the tests; this is not a PASS.**
- **No MDBX file is involved yet.**
- **Production input is REFUSED** until the final recovery-multipart r2 schema is accepted.
- **Not done by me:** tests, builds, original reads, large I/O, installs or production actions. I ran only `ast`, `bash -n` and sha256.
- **Untouched:** `recovery-multipart-stage/r1` (SUMS `59f7ec41…`, re-verified) and r2.

## Stage `multipart-validation-view-stage/r1/`, SHA256SUMS `c65284d79550c28be44096bbdb331f738ddbbb2f40aa9d235add3ac92861fc98`
| file | sha256 |
|---|---|
| `view_descriptor.py` | `23370c97956fb1a4dde30f4a657ca97e89ce452f1a982cfc29c36970113d39e0` |
| `tests/test_view_descriptor.py` (5 tests) | `b30f93b80f63b9faa01ae3f7717ed88d0b8bfcd7d84877968a67b61d4113cda5` |
| `jobs/tests.sh` (r2 receipt pattern) | `bb564a53fbe8117faea67ff110e6dca7b3c1bafd838a3d51c13592781a7a5eca` |
| `jobs/pins.sh` (qemu-nbd `b0f16ff7…`, qemu-img `3a57bce6…`, qemu-io `085e254e…`) | `9487e0c41ce3b9de85f7c9eb87fbc490ebbe8a60785067fd46e5bd3db638e9b0` |
| `README.md` | `b15f05f3daf252a860a762660a6350f9dbc6d56913853be511bd6a6ae4776a9c` |
| `refs/qemu-v11.1.2-block-vmdk.c` (official gitlab tag v11.1.2; installed 11.1.2-1) | `75dd58a247840b6fcf8be25e548bef67688317fb59c04b31f646f5af51101af3` |

## Is QEMU VMDK FLAT suitable? Yes, with mandatory guards (from the pinned source)
**Compatible with this case:**
- **Sizes:** FLAT extents have no per-extent or total sector cap (`VMDK_EXTENT_MAX_SECTORS` is used only for sparse cluster growth). 265 × 4 GiB (8,388,608 sectors each, 1,138,166,333,440 B total) is representable.
- **Paths:** absolute extent paths are opened as given, across filesystems (`/` and `/vm`). Each must be ≤ 511 bytes and contain no `"`, CR or LF.
- **Descriptor:** ≤ 1 MiB − 1. 265 lines is about 50 KB.
- **Part sizes:** the production parts are exact 4 GiB multiples of 512. A short final part works if it is a multiple of 512, and the tests cover that case.

**Hazards the builder guards:**
- **Non-`RW` lines are silently skipped** → a shorter disk. All lines are `RW`; writes are impossible via `read-only=on`, and parts must have no write bits.
- **`parentFileNameHint` anywhere** opens a backing file. It is refused.
- **Part sizes are not checked at open, and reads past EOF are zero.** The descriptor alone proves nothing. The builder hashes every part with identity held stable; `recheck` repeats the check; `check-held` verifies through `/proc/<qemu pid>/fd` that QEMU holds exactly the verified inodes. That closes the race between hashing a part and QEMU opening it.
- **Format probing of part bytes** is prevented by `extents.N.driver=file` in the image-opts.

**Not measured:** QEMU behaviour with 265 real 4 GiB extents (open time, fd count 266, read throughput). The fixture uses 4 tiny parts.

## Tests (5; expected `Ran 5 tests`)
1. **Boundary reads:** qemu-io reads straddling every FLAT boundary, one read spanning two boundaries, and the 3-sector short final part, each equal to the known bytes. Also `qemu-img info` size, `qemu-img compare` against the expected raw, and `recheck --hash`.
2. **No probing:** a part that starts with a qcow2 header is served raw; an unknown `extents.9` option is refused.
3. **Builder refusals, each leaving no output** (18 cases): missing, corrupt, wrong size, non-512, logical mismatch, gap, relative, comma, quote, `parentFileNameHint`, more than 511 bytes, symlink, writable, hardlink, duplicate, production kind, r1 manifest, existing out dir.
4. **Truncation hazard:** a truncated part reads as zeros in QEMU, and `recheck`/`opts` refuse.
5. **`check-held`:** passes for the view's own server. It refuses a server of byte-identical copies (other inodes) while `recheck` passes. It refuses after a part path is swapped to a new inode.

**Job (r2 pattern):**
- **Temp dir:** stage-specific `MVV_TEST_TMP` with `tempfile.tempdir` set explicitly in the fixtures; TMPDIR/HOME are untouched.
- **Retention:** the run dir `runs/tests-*/` keeps stdout, stderr and `receipt.json`; only the fixture tmp is removed.
- **PASS needs all of:** exactly `Ran 5 tests`, last stderr line `OK`, empty stdout (the tests capture the tool's JSON), no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, and the stage unchanged.
- **Placement and environment:** qemu-nbd binds `/proc/self/cwd/sN.sock` in the fixture dir (sun_path ≤ 108); runs as the unprivileged owner under `unshare -Urn`.

## Root
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh mvv-r1-tests 256 unshare -Urn bash multipart-validation-view-stage/r1/jobs/tests.sh   # expect "## PASS (5)"
```

## Separate integration requirement (no lifecycle written here)
- **Reuse:** `recovery-overlay-stage/r9` (`17b5528f…`): pinned `qemu-nbd --read-only --shared=1`, `nbdfuse -r -C 1`, bounded `--exec` (`mdbx_chk`, later a Reth helper) and ordered cleanup.
- **A reviewed revision must:**
  - accept this view's image-opts;
  - run `check-held` before `--exec` and `recheck` after;
  - replace r9's read-only-parent-mount gate, because the parts are on read-write `/` and `/vm`.
- **A production adapter** must bind to the accepted r2 manifest and part records.
- **A production `build`** re-reads 1.14 TB to hash; root schedules it.

## Limits
- **A view only proves** that the logical bytes equal the listed parts at build time. Saved-hash verification is distinct from MDBX structure, canonical-root and state checks, which remain required.
- **No claim** of integrity, recovery or production completeness.
