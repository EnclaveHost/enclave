# nvme-cold-relocation-stage/r10: r9 + the r9 review B1, B2, G1-G3, plus the top `ino`. FROZEN 2026-10-26 19:19Z, NOT RUN

**Status:**
- `SHA256SUMS` sha256 **`2342e677be1e000df07928238b74fe9e0688cd69ffa6bab0c79d0250ac094991`**; `sha256sum -c` OK; all 9 files 0444; no `__pycache__`/`.pyc`.
- **Unchanged:** r9 (`cc4d7cd3…`) and r8 (`433fd131…`) re-verified; r1-r7 untouched.
- **What I did:** text edits, `ast.parse`, `bash -n`, `cmp`, sha256 only.
- **What I did not do:** no test, build, sudo, live scan, namespace or mount; no edit to 370's reclaim stage. **Nothing here claims a pass.**

## Pins
| file | sha256 | note |
|---|---|---|
| `subtree.py` | **`90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3`** | r10 (1138 lines) |
| `relocate.py` | `2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0` | = r5, byte-identical (`cmp`) |
| `jobs/root-writer-check.sh` | **`7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635`** | pins `SUBTREE_SHA=90cd8968…` and `RELOCATE_SHA=2a037dae…`; dir pattern `/run/nvme-cold-wc10.????????` |
| `tests/test_subtree.py` | `820f8d774541284de645d0cd633be72a1a0f85fc4d272a0aaa8ac755fdc99347` | 39 tests |
| `tests/test_relocate.py` | `dc597306da188b97f341c016f0b3f20f6f611be157aa0dbcc3e9001bd9c7d051` | = r5, 22 tests |
| `jobs/tests.sh` | `61d7dd29df2e3c0d61d72e718f9a036a2eba3b2a58ad98706ec26c8f5973327e` | |
| `config.subtree.production.template.json` | `93e516199000b342d4d70bf48c361696a848b7b773879985bed62390f0b9c535` | = r8 (`cmp`) |
| `README.md` | `28c06b086527a6040396f22c5ef5fdebc13e9492b1e5d0ba4011b9e5a88565db` | the wrapper's three pins were checked equal to the actual file shas |

## Root commands
1. **Tests** (main queue, 512, unprivileged user namespace; offline):
   ```
   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
   bash jobs/q-exit-status.sh cold-r10 512 unshare -Urn bash nvme-cold-relocation-stage/r10/jobs/tests.sh
   ```
   - **PASS** only with r5 `Ran 22 tests` OK **and** subtree `Ran 39 tests` OK, with no skips and `## cold-r10 rc=0`, for **61** in total.
   - **Before running,** the job re-verifies the freezes of `.`, r2-r8 **and r9**, and checks that `relocate.py`, the r5 suite and the config template are byte-identical.
2. **Live read-only scan** (only after a PASS): the `<!-- r10-root-wrapper -->` block in `r10/README.md`, unchanged in shape from r9 except:
   - the staging line is `timeout 20 dd if="$S/$f" of="$W/$f" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none`;
   - the directory is `/run/nvme-cold-wc10.XXXXXXXX`;
   - the pins are the r10 ones above.
   - Then, as the owner, `r10/subtree.py record-writer-check`.

## Changes (minimal; the copy, inventory, verify, journal and r7 journal compatibility are untouched)
| item | change |
|---|---|
| **B1** | The wrapper stages with `dd … iflag=nofollow,nonblock,fullblock`. A symlinked stage file fails with `ELOOP` and is never opened. A FIFO reads empty, so the sha check fails. Root never opens a path that uid 1000 points it at, such as `/dev/watchdog`. |
| **B2** | `walk_ids` drops `os.fwalk` for an explicit fd-relative stack walk. Each subdirectory is opened `O_RDONLY\|O_DIRECTORY\|O_NOFOLLOW\|O_NONBLOCK\|O_CLOEXEC` relative to its parent's fd and `fstat`ed, and must be the `(dev, ino)` that was `lstat`ed. **A listing error, an open error or a replacement is a problem, i.e. `complete: false`; there are no silent skips.** It holds O(depth) fds. The entry counting is the same as r9, so `entries` keeps its meaning (= walk_meta records incl. the top). |
| **G1** | `parse_mounts` keeps the raw super options. Every `overlay` mount in every visible view makes the scan incomplete when any `lowerdir` (split on `:`), `lowerdir+`, `datadir+`, `upperdir` or `workdir` layer is either: **at, under or above** a target prefix; or relative, `/proc/…`, or containing `\` (not checkable by its path). Docker/containerd layers under `/var/lib/…` are unaffected. |
| **G2** | Per thread: a `task/TID/ns/mnt` not seen before adds `task/TID/mountinfo` as a view, before that thread's links and fds are matched. |
| **G3** | A fanotify mount mark whose `mnt_id` is in no visible view makes the scan incomplete. |
| **Top `ino`** | Every `state: "dir"` target has `ino` (int `st_ino` of the tree top). |
| **Format** | `nvme-cold-subtree-writer-check/r10`. `record-writer-check` refuses r8 **and** r9 results, and the cut-over gate refuses any non-r10 recorded result. |
| **Limitations** | Wording updated: loop and swap backing files are resolved by path string; overlay is checked by its layer paths, while a detached overlay or another stacking filesystem is not detected. |

## API for 370 (reclaim r3)
**Changes from r9:**
- **`format` = `"nvme-cold-subtree-writer-check/r10"`.**
- **Exact keys (18, unchanged):** `format, t, tEnd, euid, tools, prefixes, targets, hits, hitsTotal, aliases, destAliases, nsCopies, fsWatchers, incomplete, entries, complete, scan, limitations`.
- **`tools` has THREE keys and must be compared as a whole:**
  ```
  {"subtree.py": "90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3",
   "relocate.py": "2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0",
   "jobs/root-writer-check.sh": "7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635"}
  ```
  (r2's `reclaim.py:247` two-key compare would refuse every real result.)
- **`targets[]`:** `{class, subtree, path, state, entries}`. `dir` adds `majmin`, `dev` and **`ino`**; `symlink` adds `target`.
  - **Recommended binding:** the `retire`/`dest` top `(dev, ino)` = the plan's first record `id[:2]`, plus `entries` = the record count.
- **New `incomplete` reasons** (all still mean `complete: false`):
  - `… (directory not listable)`, `… changed during the scan?`, `… replaced during the scan …`;
  - `<pid> <ns> overlay <point>` with `overlay layer …`;
  - `<pid> fd/N fdinfo` with `a fanotify mount mark on a mount in no visible mount namespace`;
  - `<pid> task/<tid> ns/mnt` / `mountinfo` read errors.

**Unchanged from r9** (A3-A11 as answered in `logs/claude-cold-r9-scanner.md`):
- `t` is taken before the walk;
- `hits` ≤ 1000 with `hitsTotal`;
- `aliases`/`destAliases` shape;
- `fsWatchers` (block on non-empty);
- `complete == (incomplete == [])`;
- deleted inodes are matched by path only;
- the journal is unchanged.

## Tests (prepared, NOT run): 34 r9 tests adapted + 5 new = 39, plus r5's 22
**Adapted:**
- **R1:**
  - the marker is `r10-root-wrapper`;
  - the wrapper must contain the exact `dd` staging line and must not contain `head -c`;
  - the job refuses `wc9` and non-`/run` dirs.
- **R2:** an r9 result is refused by `record-writer-check`; recorded r8 **and** r9 results are refused by cut-over ("not an r10").
- **The fixture pids** carry a per-thread `ns/mnt`.

**New:**
1. **B1:** the README's own staging line is run as the user on a fixture stage. It copies identical bytes normally. A symlinked `subtree.py`, even one pointing to byte-identical content that r9's `head` would have accepted, fails with "symbolic links". A FIFO completes in under 15 s and never yields the real sha.
2. **B2:** `os.open` is wrapped to swap `model/` between its `lstat` and its open (r9's fwalk window), with a symlink to an outside dir, a fresh directory and a FIFO (alarm guard).
   - Each case is a reported problem.
   - Outside inodes are never in `ids`.
   - Every subdirectory open carries `O_NOFOLLOW|O_DIRECTORY`.
   - A full scan with a swap is `complete: false`, `targets` carry int `ino`, the top `ino`/`dev` equal the tree's, and cut-over is refused.
3. **G1:** six overlay mounts. Lower under a source, upper/work under a destination, an ancestor layer, a relative layer and an escaped layer are flagged; a `/var/lib` one is not. The scan is incomplete and cut-over is refused.
4. **G2:** a thread with `mnt:[55]` whose own mountinfo exposes the target fs at `/thread-alias` gives `aliases` with `ns mnt:[55]`, 3 namespaces and a complete scan. Cut-over is refused (alias).
5. **G3:** a fanotify mount mark on a known target mount is reported in `fsWatchers` and the scan stays complete. An unknown `mnt_id` gives incomplete (`4001 fd/9 … no visible mount namespace`), and cut-over is refused.

**Environment note:** the G1 test and the existing fixture views include the host's real mountinfo. On this host that contains containerd overlays (`/var/lib/containerd/…`, absolute, not under the fixture prefixes), so they are not flagged.

## Remaining real limitations (in `limitations`; none makes a missed writer harmless)
1. **Snapshot only:**
   - opens after a process was read;
   - fds in flight in SCM_RIGHTS;
   - for reclaim, the window between scan A and the unlink, which is covered by 370's per-entry identity checks and scan B, except for holders in other namespaces.
2. **Matched by path only:**
   - `io_uring` registered files;
   - holders of deleted inodes after reclamation (A7).
3. **Kernel holders beyond loop and swap** are not enumerated (nfsd/ksmbd, acct, binfmt_misc, BPF).
   - Loop and swap backing paths are `d_path` strings in the scanner's namespace (r9 review G4, not changed).
   - **Procedure:** root records `losetup -l -O NAME,BACK-MAJ:MIN,BACK-INO,BACK-FILE` and `swapon --show` with the scan.
4. **Stacked filesystems:** a detached overlay held only by an fd, and other kernel stacking filesystems, are not detected.
5. **Hangs:** `/proc/PID/maps` is read without the helper bound (r9 review G5). A process stuck holding `mmap_lock` hangs the scan, which fails closed with no result.
6. **Visibility:** the scanner must run as real root in the initial PID and user namespaces; anything less is incomplete.
7. **Not blocking in r10's own cut-over:** `fsWatchers` and `destAliases` (370 blocks on both).
8. **Live practicality is unmeasured.** Root records the runtime and the `scan` counters.
   - Stop IDE/indexer watchers of `~` and `/vm` first: large inotify `fdinfo` (more than 1 MiB) makes the scan incomplete, and `dest` watches are hits.

Not changed: production thresholds, admin controls, apps, permissions, the memory floor (the scope is 1 GiB, and the start requires ≥ 16384 + 1024 MiB available). There is no deletion phase and nothing was cut over.
