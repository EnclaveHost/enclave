# 1660: recovery-overlay-stage/r1, a disposable READ-ONLY metadata recovery view (FROZEN, NOT run). Report and limitations

**Status:** source frozen, NOT run.
- **Stage:** `recovery-overlay-stage/r1/`, **`SHA256SUMS` sha256 `a8243779228b7cce400f081721a16ebd701cc5a681c62cd0a39f0fb9bcd7430a`**. Files are read-only, and `sha256sum -c` passes.
- **Not done by me:** tests, builds, mounts, NBD, qemu, live actions, USB, or reads of the original image.
- **Executed by me:** read-only inspection of local proof files and tool help, `sha256sum`, `ast.parse`, `bash -n`.
- **Nature of the result:** a diagnostic recovery view, **not** a recovery, restore or production acceptance. Data blocks are not authenticated.

| file | sha256 |
|---|---|
| `overlay_plan.py` | `f119f2f7…` |
| `overlay_session.py` | `db1da611…` |
| `fixture/make_fixture.py` | `580b7946…` |
| `tests/test_recovery_overlay.py` (8 tests) | `c2e4ffcf…` |
| `jobs/common.sh` | `4ad4c129…` |
| `jobs/tests.sh` | `d385c4f9…` |
| `jobs/root-plan-real.sh` | `5f2912d1…` |
| `jobs/root-expose-real.sh` | `2cffff74…` |
| `README.md` | `89f03e7e…` |

## What r1 does
1. **`overlay_plan.py` (offline; local inputs only).** It builds 30 patches (118,272 bytes):
   - the **256 inode bytes only** (block 499122230 + 1024; inode 1950053, gen 3326586236, journal 118422, sequence 17169);
   - the 28 tree blocks (index 499155449 plus 27 leaves, as root 1658 chose);
   - the `/data/db` directory block 499122346.

   **Every patch must pass all of the following:**
   - **proof:** it is the exact **proven** JBD2 image in root's 1649 `result.json` (journal block + sequence, committed, not partial);
   - **content:** its unescaped bytes re-read from the pinned journal copy `d95d81fc…` hash to `contentSha256`;
   - **checksums** (with the frozen ext4 checker `662291e5…`, whose crc32c is cross-checked against libext2fs):
     - the inode's checksum;
     - the exact referenced tree-block set;
     - every extent block's checksum and parent start;
   - **extent map:** the leaf extents **equal 1658's `map.extentList`**;
   - **directory block:**
     - its tail CRC must verify for dir inode 1949710 **gen 1611750745**;
     - it must hold exactly one live `mdbx.dat` → 1950053 (ft 1);
     - it is the **latest** proven image ≤ 17169, never an older one silently.
2. **`overlay_session.py`:** a new qcow2 overlay (`-u -F qcow2 -b ORIGINAL`), patched by `qemu-io write -s`, then:
   - a cap check (64 MiB) and `qemu-img check`;
   - **our own foreground** `qemu-nbd --read-only`, then `nbdfuse -r`, then the pinned peer `fuse2fs -f -o ro,norecovery,fakeroot`;
   - read-back, write-refusal, size and sample checks (fixture: the whole-file sha256);
   - an optional `--exec` validator or a `--hold`;
   - **cleanup always:** our mountpoints only, our children reaped through their handles, our socket, overlay deletion, a leftover-process scan, and a parent identity re-check.
3. **Fixture:** a tiny controlled delete (mkfs/debugfs on image files; depth-2 tree; inode reuse with a new generation) and a reused-data variant. There are 8 tests (see README).
4. **Jobs:**
   - **`tests.sh`:** pins and guards; peers' mounts and processes must be identical before and after; strict receipt.
   - **`root-plan-real.sh`:** offline, under `unshare -Urn`.
   - **`root-expose-real.sh`:** needs the 1659 gate receipt; the original's mount must be `ro`; refuses if the original is writable.

## How r1 meets root's three requirements, and where it falls short
### 1. Original/backing read-only, including during the overlay write stage
**Holds:**
- **Before anything is created:** the session refuses a parent that is writable by this user (`os.access W_OK`; the real original is on a `ro` fuseblk mount, and the expose job also checks `findmnt … ro`). So the **kernel** refuses any write to it, whatever qemu does.
- **`qemu-img create -u`** never opens the backing.
- **`qemu-io`** opens the overlay RW with `backing.read-only=on` (and `backing.file.locking=off`, so the peer's read-only `qemu-nbd` is not disturbed).
- **The exposure** is `qemu-nbd --read-only` + `nbdfuse -r` + `fuse2fs ro,norecovery`.
- **The jobs refuse real root.**

**Gaps (r2):**
- **(a)** `locking=off` also removes qemu's protection against a **concurrent writer** of the parent. This is acceptable only because the mount is `ro`; r2 should assert the `ro` mount inside the session, not only in the job.
- **(b)** The fixture's parent is protected by **mode 0444 only**, not a read-only mount. A process running as root could still write it; the fixture tests are unprivileged by guard.

### 2. Hard byte and space bounds: **NOT hard enough in r1 (fix in r2)**
- **The overlay cap is checked only AFTER the `qemu-io` writes (post-hoc).**
  - **Real plan:** 30 patches, i.e. ≤ 30 × 64 KiB clusters plus metadata, about 2 MiB.
  - **The session itself does not bound the patch count:** the plan builder allows up to 4096 tree blocks, so a pathological plan could grow the overlay to about 260 MiB before the refusal.
  - **r2:** in the session, before any write, require ≤ 64 patches, `patchBytes` ≤ 1 MiB, and (patches × cluster size + the L1/refcount estimate) ≤ cap.
- **Free space:** the session requires ≥ 1 GiB free, but **`tests.sh` does not check** free space for the fixture (about 0.3 GB worst case: a 96 MiB raw ×2, a 16 MiB filler, the qcow2 parents). **r2:** a `statvfs` floor in the job.
- **During exposure** the overlay cannot grow (NBD read-only). Reads by `--exec` (the 1.14 TB validator) go through the page cache and are **not bounded here**; that belongs to the 1661 validator stage's budget.
- **Memory:** `fuse2fs cache_size=64M`, plus qemu-nbd/nbdfuse and Python, within the queue's 512 MiB lane (unmeasured).

### 3. Ownership-safe cleanup: holds for normal paths; three gaps
**Holds:**
- **Only our children:** every server is a foreground `Popen` child (never `--fork`). Signals go only through our **unreaped** handles, so the PID cannot have been reused.
- **No daemons:** an `nbdfuse` that daemonizes is refused, and is then ended by unmounting our own view.
- **Unmounting:** only our exact mountpoints are unmounted (`/proc/self/mountinfo` exact path match).
- **Peers:** never touched; the jobs compare peer mounts and processes before and after.

**Gaps (r2):**
- **(a) The validator's grandchildren.** On an `--exec` timeout, `subprocess.run` kills only the direct child. Grandchildren in its session can keep the mount busy. The `fusermount3 -u` then fails, and the session reports **rc 4, cleanup incomplete** (safe, but manual). **r2:** `killpg` the exec's own process group, which is PID-reuse-safe while the group exists, and scan for leftovers by session ID as well as by command line.
- **(b) The session process itself killed** (queue memory-guard SIGKILL or `timeout -k`). `finally` does not run, so stale FUSE mounts may remain under `runs/…/work`. **r2:** a `cleanup RUN_DIR` subcommand that unmounts only mountpoints **inside that run dir** and verifies that nothing names it. Until then, the manual step is `fusermount3 -u RUN/work/mnt; fusermount3 -u RUN/work/view`.
- **(c) A fuse2fs that dies before unmount** leaves a stale mount. It is detected (rc 4) but not repaired automatically.

## Other limitations (honest)
- **L1, the JBD2 provenance path is NOT exercised by the fixture.**
  - **Why:** debugfs does not journal, so the fixture's "proven images" are a direct capture.
  - **What is untested:** `plan_real` (`proven`/`read_proven`/directory selection, the extent-list comparison) runs only in root's real **offline** plan job.
  - **r2:** a unit test with a synthetic `result.json` and journal file built from the captured images, including escaped, partial, wrong-sequence and wrong-sha cases.
- **L2, version freshness of the tree blocks is checked structurally, not chronologically.**
  - **What r1 checks:** each tree block is root 1658's chosen image, checksum-valid, in the exact referenced set, and the map equals 1658's.
  - **What r1 does not check:** that no **newer** proven, checksum-valid image of the same block exists with sequence ≤ 17169. The index was chosen at 16490 and the leaves at mixed sequences up to 17027.
  - **Evidence so far:** root 1658's accounting PASS (data blocks + 28 = `i_blocks`) is strong evidence, not proof.
  - **r2:** refuse if any newer proven image ≤ the inode sequence is valid for (ino, gen).
- **L3, other files become inconsistent:** the overlay mixes old metadata into the current filesystem (inode-table neighbours current, bitmaps current, blocks possibly reused). That is why it is **never** mounted RW, booted, or used for anything but `/data/db/mdbx.dat`.
- **L4, the samples are not authentication:** they prove that the view reads the restored map's physical blocks. They do not prove those blocks still hold the original data. Reuse is possible in principle, but 1657 found all 9001 extents free, and the 1659 gate is pending. The MDBX validator (1661) plus chain-state checks must judge content.
- **L5, tool assumptions untested:**
  - `nbdfuse` staying in the foreground with `-P` (refused otherwise);
  - `fuse2fs` positional/option order with `-f`;
  - qemu `--image-opts` overrides of the backing node (`backing.read-only`, `backing.file.locking`);
  - `qemu-io` writing with `-s`.

  Errors there fail closed (rc 3, with cleanup), but would need an r2 adjustment. `qemu-io`'s exit status can be 0 on a failed write; r1 also greps for failure words, and the read-back check catches a mismatch.
- **L6, no network namespace:** the tests and expose jobs run **without `unshare`**, because FUSE needs the host `fusermount3`. They use only unix sockets in the run dir.
- **L7, the parent check for the real image is stat-only** (dev, ino, size, mtime_ns, ctime_ns). There is no hash of the 1.14 TB file; its read-only mount is the enforcement.
- **L8, the real expose reads the original over USB** (qcow2 header, about 30 COW clusters, plus whatever the validator reads). It is read-only, but it is USB I/O while writes and downloads are paused.

## Recommended order (root)
1. **Fixture tests only, first:**
   ```
   bash jobs/q-exit-status.sh rov-r1-tests 512 bash recovery-overlay-stage/r1/jobs/tests.sh
   ```
   Expect `## PASS (8)`, `peersUnchanged`, `noMountsLeft`.
2. **Before any real expose,** I recommend an **r2** with:
   - the hard pre-write bounds (§2);
   - the session-level `ro` assertion (§1a);
   - process-group cleanup and a `cleanup` subcommand (§3a/b);
   - the synthetic JBD2-path tests (L1);
   - the chronological freshness check (L2).

   r1 stays frozen and is not mutated.
3. **The offline real plan** (`root-plan-real.sh`) may run for review after the fixture PASS. It reads only local copies.
4. **The real expose:** only after the 1659 transient-reuse gate **and** r2.
