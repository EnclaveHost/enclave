# Independent source-only review: `nvme-cold-relocation-stage/r9` (2026-10-26 19:01–19:10Z)

## Bytes reviewed
**r9:**
- `SHA256SUMS` **`cc4d7cd373a22c2f37bf7c5cd26eae06a5e84a644363b8d508fa34b35e598f5d`**; `sha256sum -c` OK, all 0444.
- `subtree.py` `ba716ac4…` (all 1067 lines; the scanner part `:586-960` line by line), `relocate.py` `2a037dae…` (the `Env`, `check_mount`, `walk_meta` and `identity_now` helpers used), `jobs/root-writer-check.sh` `316f4e8e…`, `jobs/tests.sh` `d58ad33f…`, `README.md` `d58c12d7…`, config template `93e51619…`.
- The names of the 34 test methods only; the R1 wrapper test assertions were spot-read.

**Also read:**
- `logs/claude-cold-r9-scanner.md` and my r8 review (R1-R4).
- For format compatibility only: 370's `nvme-cold-reclaim-stage/r2` (`SHA256SUMS` `4b0cd38d…`; `reclaim.py:233-292`, `:500-579`, config template) and `logs/claude-cold-reclaim-r2.md`.

**System facts used (read-only):**
- CPython `/usr/lib/python3.14/os.py` `_fwalk` (3.14.8, the `/usr/bin/python3` the job execs).
- `/dev/watchdog` and `/dev/watchdog0` exist: SP5100 TCO, `state inactive`, `timeout 60`, `nowayout 0`; `RuntimeWatchdogSec` is not set in `system.conf`.
- `fs.protected_hardlinks=1`, `fs.protected_symlinks=1`.
- The observed production config `logs/cold-subtree-production-1530.json` (`bae6021b…`): `writer_check_max_age_seconds = 120`, `owner_uid = 1000`.

**Not done:**
- no test, build, sudo, scan, mount, namespace or `findmnt` across namespaces;
- no edit to any stage, including 370's;
- nothing except this file.

**Root's own test run** (`r9/runs/run-20261026T190126Z-2177429/`):
- its log files show `Ran 22 tests … OK` and `Ran 34 tests … OK`;
- the job's rc and verdict are root's to report; I did not run or qualify anything.

**Live status assumed from root:** the 169 GB copies are verified and the originals are intact; there has been no cut-over and no deletion. Nothing in r9 touches the copy/verify path (`relocate.py` and the config template are byte-identical; the journal is unchanged).

## Verdict
**Offering the READ-ONLY root scanner: not as written. Two cheap blockers.**
- **B1** is a change to the wrapper text only; no stage change is needed to run it.
- **B2** is a ~25-line `walk_ids` change.
- **The cause of both:** root opens a path chosen by uid 1000. On this host the obvious payload is `/dev/watchdog`, which is free and inactive, so opening it arms a 60 s hardware reset of the production host.
- **Everything else is sound:** what the scanner touches, how it bounds its work, what it reports and how it fails closed.

**CUT-OVER and RECLAIM** additionally need:
- B2's completeness half;
- G1-G3: three cases where the scan can say `complete: true` while missing users or aliases;
- 370's `tools` compatibility fix (C1);
- the live procedure items listed below.

None of these is a reason to call a missed writer harmless. Each one must be fixed, or closed by a recorded root check.

---

## Blockers to OFFERING the read-only sudo scanner
### B1. The wrapper's `head` follows a symlink, so root opens a file of uid 1000's choosing (no race needed)
- **The cause:** `timeout 20 head -c 1048577 -- "$S/$f"` opens `$S/$f` with a plain `open()`. `$S` is a directory owned by `steven`, so uid 1000 can replace `subtree.py` with a symlink at any time before root pastes the wrapper.
  - The sha check then fails, correctly: nothing is executed and the temp dir is removed.
  - **But the open has already happened.**
- **The effect:**
  - `open()` of `/dev/watchdog` starts the watchdog. `head`'s read fails, and the close without the magic `V` leaves it running ("watchdog did not stop!"). With `nowayout 0` and no daemon pinging it, the host resets after about 60 s.
  - This follows from the kernel watchdog-core semantics; I have not tested it.
  - Other devices with open-time side effects (tape, serial DTR, tray) are the same class of problem.
- **FIFOs are already covered:** `timeout 20` handles them.
- **Minimal fix (wrapper literal only; the staged job and Python are unchanged and the pins are the same):** replace the copy line with
  ```bash
  for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 dd if="$S/$f" of="$W/$f" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none; done
  ```
  - **Why this is enough:**
    - `O_NOFOLLOW` on the last component means a symlink fails with `ELOOP`.
    - uid 1000 cannot create a device node or hardlink one (no `CAP_MKNOD`, `protected_hardlinks=1`, `/dev` is another filesystem), and a symlinked directory component can only lead to names that don't exist as devices.
    - `nonblock` means a FIFO reads empty, so the sha fails.
- **Stage impact:** r9's R1 test asserts the literal `timeout 20 head -c 1048577` in README. The README change and that test assertion therefore belong in an r10. **Root can run the corrected literal today:** the three pins are unchanged.

### B2. `walk_ids` uses `os.fwalk`, which opens each subdirectory with a symlink-following `open()`
`subtree.py:648`; CPython 3.14 `os.py:510-525`.
- **The cause:** `_fwalk` does `stat(name, follow_symlinks=False)` and then `open(name, O_RDONLY|O_NONBLOCK, dir_fd=…)`. There is **no `O_NOFOLLOW` and no `O_DIRECTORY`**, and the identity comparison comes only after the open.
- **Two consequences:**
  1. **Root-side open (race):** a uid-1000 process can swap a directory inside the destination tree (`~/.cold-archive`, owner 0700) or the owner's source tree for a symlink to `/dev/watchdog`, between the `lstat` and the `open`. Root opens the device; the impact is as in B1.
     - It needs an active process timing the walk, which is easy with inotify on the tree.
  2. **Silent omission:** on a `samestat` mismatch `_fwalk` simply `return`s. `onerror` is not called and nothing reaches `probs`, so the whole subtree under that directory is **missing from `ids`** while `complete` stays `true`.
     - **A benign case triggers it too:** any concurrent replacement of a directory during the walk.
     - Holders of those inodes are then missed. That is a completeness bug, not only a security one.
- **Minimal fix (r10, `walk_ids` only):** drop `os.fwalk` and walk with an explicit stack of `(dir_fd, pending subdir names)`. This holds O(depth) fds, not O(width).
  - Per entry, `os.stat(name, dir_fd=dfd, follow_symlinks=False)` as now.
  - Per subdirectory:
    - open it with `os.open(name, O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC, dir_fd=dfd)`. `O_DIRECTORY` fails during path lookup, so it never reaches a device driver's `open`.
    - `fstat` the fd and require the same `(st_dev, st_ino)` as the `lstat`.
    - **Any error or mismatch must append to `probs`** ("changed during the scan"), which means incomplete. It must never be skipped silently.
  - Keep the other-filesystem check, the entry budget and `entries` as they are.
- **Tests:**
  - swap a subdirectory for a symlink between the stat and the open (through an injected hook): the result must be `incomplete`, and the symlink target must never be opened or walked;
  - replace a subdirectory with a fresh directory: `incomplete`.
- The new `subtree.py` sha means new wrapper and job pins, and 370's pins follow (C1).

**Not blockers for offering** (all hold, as checked in source):
- **Execution:** root executes only the staged, sha-verified copies. The staged job checks the dir pattern, owner, 0700, root-owned regular files and the two Python pins, then runs `exec env -i … /usr/bin/python3 -I -B` (`-I` keeps the script dir out of `sys.path`). `relocate.py` is compile+exec of verified bytes, with no pyc involved. `cd /` happens before exec.
- **Config FD validation (R2):** each component is opened `O_PATH|O_DIRECTORY|O_NOFOLLOW` from `/`, and the file `O_NOFOLLOW|O_NONBLOCK`. `fstat` must show a regular file, not group/world-writable, ≤ 64 KiB, and the owner is checked against the file actually read. Content is parsed from that fd only, and refusals carry no content.
  - **Known cost (A12):** a symlinked system component such as `/home` refuses.
  - **Low note:** `owner_uid` is self-declared and not pinned. That doesn't matter for the scan, which uses only the pinned paths.
- **Writes:** none by root except `$W`, removed by the trap. The JSON goes to stdout through the owner's redirect.
- **Memory:**
  - the scope is 1 GiB with no swap;
  - the start requires MemAvailable ≥ 16384 + 1024 MiB, so the 16 GiB host floor is preserved;
  - `ids` is ≤ 2,000,000 entries. Realistic trees are much smaller (the manifest has 2,102 entries).
- **Disclosure to uid 1000 through `RESULT.json`:**
  - paths only under the targets or their aliases, `comm` (≤ 64 characters), mount points of alias namespaces, and error strings;
  - fanotify mark lines (≤ 200 characters);
  - no file content.

---

## Completeness: what I checked and where `complete: true` can still overstate
**Holds:**
- **Matching:**
  - `cwd`/`root`/`exe` of each process and per-thread `cwd`/`root` go through a bounded `stat` (5 s helper thread; more than 16 timeouts aborts as incomplete);
  - every fd is matched through fdinfo `mnt_id` + `ino`. Mount ids are system-wide, so a single `mnt_dev` map is correct. Detached or lazily unmounted mounts fall back to a bounded `stat`;
  - unshared thread fd tables (`kcmp`, with unknown treated as scanned), `maps` dev:inode, and inotify/fanotify inode marks (`sdev` decoded as `major<<20|minor`) are all covered.
- **Aliases:**
  - the `best`-mount overmount check covers bind/idmapped aliases of the same superblock across every visible namespace, including an ancestor bind (`root` above the target) and a part of the target mounted on its own;
  - a mount namespace held only by an fd or an nsfs mount makes the scan incomplete;
  - a process in a detached `open_tree` clone is still an fd inode hit, through the fallback.
- **Truncation:** `hits` ≤ 1000 with `hitsTotal` the full count. r9's cut-over refuses when `hits` is non-empty or `hitsTotal` is non-zero; 370 refuses `hitsTotal != len(hits)`.
- **Watchers:** `fsWatchers` stays non-blocking for r9's own cut-over (watchers are not writers, and cut-over keeps `.retire`). It is blocking in 370.
- **Freshness:**
  - `t` is taken **before** the target walk (conservative) and `tEnd` after;
  - a rename during or after the scan keeps inode numbers, so the `.retire` class stays matched.
- **Logs and outputs are bounded:**
  - stderr carries only the `fs.protected_*` line and typed refusals; unexpected exception types become a traceback, which fails closed;
  - `mountinfo` and `fdinfo` reads are capped at 1 MiB, with overflow treated as incomplete.

**Gaps.** Each one can let a real holder or alias pass with `complete: true`:

| # | gap | consequence | minimal fix (r10) |
|---|---|---|---|
| **G1** | **Stacking filesystems (overlayfs).** A file in a target tree used as an overlay **lower/upper/work** layer is opened by the kernel. The user's fd shows the overlay `mnt_id` and an overlay dev or inode, so it never matches `ids`. The alias check ignores the overlay mount because its `majmin` (0:N) is not the target device. | Missed users. With the **upper** layer in a target tree they are missed **writers**. Kernel overlay is possible for root containers and for rootless containers in a user namespace. | `parse_mounts`: also keep the super-options field. In `scan_users`, for every `overlay` mount in every view: if any `lowerdir`/`lowerdir+`/`datadir+`/`upperdir`/`workdir` string is under a prefix, **or a prefix is under it** (an ancestor layer), or it is not absolute, starts with `/proc/`, or contains `\` (unverifiable), then call `inc(...)`. That is about 12 lines. Docker, podman and flatpak layers elsewhere are unaffected. **Residual:** a detached overlay held only by an fd is not visible; record it as a limitation. |
| **G2** | **Per-thread mount namespaces.** A thread can `unshare(CLONE_FS)` and then `unshare(CLONE_NEWNS)`. Only `/proc/PID/ns/mnt` (the leader's) is read. | Holders are still inode hits (the fallback `stat`). But **aliases** visible only in that thread's namespace are missed, and they are the paths a future writer could use. | In the tid loop, before `fds(...)`: read `task/TID/ns/mnt`; if it is new, add a view from `task/TID/mountinfo`. About 4 lines. |
| **G3** | **fanotify mount mark on an unknown `mnt_id`.** `d = mnt_dev.get(...)` returns `None`, so it is silently ignored. | A missed `fsWatchers` entry, which is exactly the thing 370 blocks on. | Add `if d is None: inc(…, "fanotify mount mark on a mount in no visible namespace")`. One line. |
| G4 (minor) | **Loop and swap backing paths are `d_path` strings in the reader's namespace.** The backing namespace may be gone while a same-named path exists in the scanner's namespace. | Possibly the wrong file is checked. This is unlikely: loop and swap setup needs real root, and live cases surface as aliases or ENOENT, which is incomplete. | `LOOP_GET_STATUS64` gives exact `lo_device`/`lo_inode`; compare those. **Until then:** root records `losetup -l -O NAME,BACK-MAJ:MIN,BACK-INO,BACK-FILE` and `swapon --show` in the cold-proof checks. |
| G5 (minor, fails closed) | **`/proc/PID/maps` is read without the helper-thread bound.** A process stuck holding `mmap_lock` (on a hung FUSE or NFS fault) blocks the read. | A hung scan. No result means fail closed, and the operator must Ctrl-C. | Optional: read `maps` through the same bounded helper. |
| G6 (operational) | **inotify `fdinfo` over 1 MiB** (IDE watchers with more than about 13k watches) is incomplete, and an IDE watching `~` makes `dest` inode hits. | Correct and conservative, but it blocks repeatedly. | Procedure: stop watchers of `~`/`~/.cold-archive` and `/vm` before scanning. |

**Stated limitations that remain** (none is harmless; each needs an operator-recorded check for reclaim):
- snapshot (opens after a process's entries were read);
- SCM_RIGHTS fds in flight;
- `io_uring` registered files by path only;
- kernel holders beyond loop and swap (nfsd, ksmbd, `acct`, binfmt_misc `F`);
- holders of deleted inodes after deletion are matched by path string only (A7).

**Freshness and identity versus rename:**
- **Cut-over:** age ≤ `writer_check_max_age_seconds`, which is 120 in the observed config but has **no code cap**. Recommend a cap of ≤ 600 or a pin of 120 in r10; non-blocking with the observed config. Also: the prefix is present, the source is walked (`dir`, entries > 0), then `identity_now(src) == verified` immediately before the rename. That is sufficient for cut-over.
- **The result binds a tree only by `dev` + `entries`; there is no `ino` or `idsDigest`.**
  - A swap of the whole `.retire-<name>` top (rename it away, scan a decoy with the same count, rename it back) is not detected, because walk_meta excludes the top's ctime.
  - **Recommended, cheap, non-blocking:** add the top `ino` to each `dir` target in r10. It is a new field inside `targets` with the same WC_KEYS, so it is compatible with 370 r2. 370 can then bind the top `(dev, ino)` to its plan's first record.
  - This needs a deliberately malicious uid-1000 actor; it is beyond the trusted-operator baseline.

---

## Blockers to CUT-OVER (r9's own gate)
1. **B2's silent-omission half fixed** (r10), then root's test run on r10.
2. **G1-G3 fixed** (r10), **or** for the cut-over only, a root-recorded check in the same session:
   - `findmnt -A -t overlay -o TARGET,OPTIONS`, plus every namespace's `mountinfo`, showing no overlay layer at, under or above `/vm/enclave-volumes/codex-archive/2026-10-24/home/*` or `~/.cold-archive`;
   - no fanotify mount marks (`grep -l '^fanotify mnt_id' /proc/*/fdinfo/*` empty).
   - A cut-over itself loses no data: `.retire` keeps every byte, and R4's identity check catches writes that completed later. A gap only becomes data loss at reclaim.
3. **A live root scan** with the B1-fixed literal: `complete: true`, `hitsTotal 0`, no `aliases`, ≤ 120 s before `cutover`. Root records the runtime and the `scan` counters, which are unmeasured.
4. **Unchanged from r8:** the cold-proof checks (no readers or writers; the Qwen maps), the apps-stopped attestation, and a single `/vm` mount of `cryptvm`.

## Blockers to RECLAIM (370 r2 consuming r9)
**C1. Format compatibility bug (fails closed, but it is not "pin-only").**
- **The mismatch:** `reclaim.py:247` requires `res["tools"] == {"subtree.py": …, "relocate.py": …}`, two keys. r9 emits **three** keys, including `"jobs/root-writer-check.sh": 316f4e8e…`. Every real r9 result would therefore be refused.
- **The follow-up must:**
  - add `R9_JOB_SHA256`;
  - compare the 3-key dict;
  - keep the "unset → disabled" check covering all three pins.
- **If r10 lands (B2/G1-G3),** all pins move to r10's shas.

**Other r9 fields, checked against `accept_scan` and `bind_target`:**
- `format` and the 18 keys match;
- `complete is True` and `incomplete == []`;
- `t < tEnd ≤ now + 1`, age ≤ the r8 config's 120;
- `hitsTotal == len(hits)`;
- this subtree's hits (by `subtree`, or a path under source, retire or destination) block;
- `aliases` and `destAliases` for this subtree or with none block, as does any non-empty `fsWatchers`;
- the source target must be a `symlink` to the destination;
- the `idsDigest` check is optional (absent in r9, so it is skipped), and `targets` carry `dev`/`entries`/`state`.

All of these are compatible.

**Note only (370-owned, not edited):** `accept_scan` reads the result with `os.lstat` and then a path `read_bytes` (follows symlinks, unbounded after the check). It runs as the owner, not root, so the impact is low. Reusing r9's `read_bounded` would close it.

**Required before any deletion:**
- C1;
- B2 + G1-G3 fixed in r10 and qualified by root;
- G4 recorded (`losetup`/`swapon`) or fixed;
- a live scan A with `complete: true` **covering the retired and destination inodes and aliases**;
- 370's per-entry identity, scan A ≤ 120 s, and scan B after deletion.

**Residuals to state at the decision, not to call harmless:**
- a cross-namespace fd opened in the ≤ 120 s window between scan A and the unlink;
- `io_uring` registered files;
- unenumerated kernel holders;
- scan B's path-only view of deleted inodes.

The apps-stopped attestation is the control for these.

## Unchanged
- No production thresholds, admin controls, apps, permissions or memory floor change.
- No deletion or cut-over.
- This review adds no features. The fixes above are the minimum for the stated blockers.
