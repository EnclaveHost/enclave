# qcow-allocation-nbd-stage/r1: compact READ-ONLY allocation status of the 9001 candidate extents (1705). FROZEN 2026-10-26 21:28Z, NOT RUN

## Why not `qemu-img map` or `nbdinfo --map`
- **Root 1702** (`jobs/root-qcow-recovery-map-1702.py`, sha256 `7b3488d9…`) stopped cleanly with **rc −9, `cut: True`** at its 32 MiB output cap (`logs/root-qcow-recovery-map-1702.out`). The original was unchanged and the job had no write path. The JSON map of a 1.14 TB fragmented qcow2 is simply too verbose.
- **`nbdinfo --map`** (1.24.4, `/usr/sbin/nbdinfo` `7bd887de…`) prints one line per extent: the same verbosity.
- **`nbdinfo --totals`** sums the **whole disk**, not the candidate ranges.
- **Neither gives per-range totals without buffering the whole map,** so a small purpose-built client was needed.

## Design (stdlib + the installed libnbd Python binding; no new framework)
**Client:** `alloc_check.py`, using `import nbd` from `/usr/lib/python3.14/site-packages/nbd.py`, libnbd **1.24.4**, sha256 `4a64b120…`. Its API was checked with local `help()`: `block_status(count, offset, extent_cb)` is 32-bit, the server may return less, the final extent may extend past the range, and `STATE_HOLE=1`, `STATE_ZERO=2`, `CONTEXT_BASE_ALLOCATION`.

**Server:** our **own foreground child**, `qemu-nbd --read-only --shared=1 --allocation-depth --socket=<private run dir> --image-opts driver=qcow2,file.driver=file,file.filename=IMG,file.locking=off,read-only=on`.
- **Pinned:** `/usr/sbin/qemu-nbd` 11.1.2 `b0f16ff7…`, the same pin as the overlay stage.
- **Isolation:** its own session with `PR_SET_PDEATHSIG` SIGTERM.
- **The deadline:** a watchdog thread SIGKILLs its group at `--timeout` (default 7200 s), so a hung server cannot block the libnbd call forever.
- **Cleanup:** wait 10 s, then TERM and KILL its group, which is still unreaped; the socket is removed.
- **Why not socket activation:** I used an explicit unix socket instead of `connect_systemd_socket_activation` so that **we** own the server's lifecycle and deadline. libnbd's own subprocess handling is not bounded by us.

**The request loop:**
- `connect_unix`; require `can_meta_context("base:allocation")` and `is_read_only()`. `qemu:allocation-depth` is recorded if offered (informational: 0 unallocated, 1 this image).
- Every range must end ≤ the export size.
- For each candidate range, `block_status` is called in **≤ 1 GiB chunks** (32-bit count), **clipping** every returned extent to the range, with an explicit no-progress refusal and a cap of 20 M calls.
- **No NBD read is ever issued.**

**Output** (a new 0600 `result-*.json`; compact):
- totals in bytes: `allocatedData` (no flag), `holeZero` (3), `hole` (1), `zeroNotHole` (2);
- `rangesFullyAllocatedData` and `rangesWithHoleOrZero`;
- at most 32 non-data samples `{start, length, flags[, depth]}`;
- allocation-depth byte totals, the number of calls, and whether extended headers were negotiated;
- the image identity before and after (`imageUnchanged`) and `cleanupComplete`;
- the explicit meaning: **"image-layer ALLOCATION status only; NOT content integrity; no data byte was read"**.

**Exit codes:** 0 written; 3 refused, with no claim; 4 identity or cleanup problem.

## Stage `qcow-allocation-nbd-stage/r1`, SHA256SUMS **`1d079b3d6f8ad99719ada773f633e3b07296eaf0d9dabd18e947f6b9a22b4c87`**
| file | sha256 |
|---|---|
| `alloc_check.py` | `65d53fca8a5cd9f7616706926da39c8e8602c3c2c3dcb80623a7a5c6e99c4d5b` |
| `tests/test_alloc_check.py` (3 tests) | `1684ec67980266e0d4ac392475c472a430576c93d37d008781f57d3e627b1bf1` |
| `jobs/pins.sh` (qemu-nbd `b0f16ff7…`, qemu-img `3a57bce6…`, qemu-io `085e254e…`, nbd.py `4a64b120…`) | `caede1a5cb85ceff40abbbdf719faa1b40ed8f20e98df960b61a221899784468` |
| `jobs/tests.sh` | `a8dc0dc857bec5dce872716c61901aeaaf1b553c0f2573f358cf2b2702055726` |
| `jobs/root-real.sh` | `b1a27b90b3e9f62144ba7e9aae512c68f0d3a65e6b02531ac2b7c06193cd138a` |

**What I did:** `ast` parse, `bash -n` and sha256 only. **What I did not do:** no test, build, server start, mount, USB or original access.

## Fixture tests (3; a tiny 4 MiB qcow2 with 64 KiB clusters, made with the pinned qemu-img/qemu-io)
**Known layout:**

| range | content | expected class |
|---|---|---|
| [0, 128 K) | `write -P 0xaa` | allocated |
| [128 K, 256 K) | untouched | hole |
| [256 K, 320 K) | `write -z` | zero cluster |
| [320 K, 384 K) | `write -P 0` | **allocated data whose content is zero** |
| [1 M, 1088 K) | `0x55` | allocated |

The image is 0444, and its sha256 is checked before and after.

1. **Exact classification:**
   - `allocatedData` = 256 K, including the zero-content data cluster;
   - non-data = 192 K, all with the ZERO flag;
   - range counts 1/1;
   - image unchanged and cleanup complete;
   - no process names the run dir afterwards.
2. **Bounded chunking:** with a 64 K chunk over the whole 4 MiB, the sum is exactly 4 MiB, `allocatedData` 256 K, and ≥ 64 calls.
3. **Refusals** (rc 3, a result containing only `refused`): a range beyond the export, overlapping ranges, an empty range, a wrong qemu-nbd pin, a writable image.

**Note:** the tests run **unprivileged and not in a user namespace**, so the 0444 fixture is really unwritable.

## Root order
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh qcow-alloc-r1-tests 512 bash qcow-allocation-nbd-stage/r1/jobs/tests.sh     # "Ran 3 tests", OK, rc=0
bash jobs/q-exit-status.sh qcow-alloc-r1-real  512 bash qcow-allocation-nbd-stage/r1/jobs/root-real.sh # only after the PASS
```
**`root-real.sh` refuses unless all of these hold:**
- the pins match, and the fixture log shows `rc=0`;
- the original (the 1702 path, `…/tr004-readonly/…/base-origin.qcow2`) is a regular file on a **read-only mount**;
- the manifest sha is `a2843215…` and `discard` is `ignore`;
- the candidate map `ext4-candidate-checksums.json` has sha `70180b22…` and 9001 non-overlapping extents totalling exactly 276,959,557 × 4096 B;
- **no process names `base-origin.qcow2`.** The peer server is closed; if anything holds it, the job **refuses and touches nothing**.

It then runs `alloc_check.py` under `timeout -k 60 8000` with a 7200 s internal deadline. The outputs are `runs/real-*/{preflight.json, ranges.json, result-*.json, qemu-nbd.out}`.

## Interpretation and limits
- **`allocatedData`** = candidate bytes backed by allocated qcow2 data clusters. **`hole`/`zero`** = bytes that read as zeroes from the image layer: deallocated, a zero cluster, or never written.
- **Any non-data byte inside the candidate map means those file blocks cannot hold the original data in this image.** Report the totals and samples; never "intact".
- **Allocated ≠ correct content.** Allocated clusters may have been overwritten after the deletion. Content integrity still needs the full MDBX / trie / canonical-root gates.
- **Discard was `ignore`** (per the manifest), so guest TRIM did not deallocate qcow2 clusters. That still says nothing about rewrites.
- **Not pinned:** the libnbd C library (`libnbdmod`/`libnbd.so`) is not pinned separately; only `nbd.py` is.
- **qemu-nbd's maximum block-status reply** is server-defined; the loop handles any shorter reply.
- **Runtime is unmeasured;** the real run reads only qcow2 metadata (L1/L2 tables), through qemu.
