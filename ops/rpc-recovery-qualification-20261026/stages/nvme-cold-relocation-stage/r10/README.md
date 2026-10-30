# nvme-cold-relocation-stage/r10 (PREPARED by Claude; nothing run): r9 + the r9 review B1, B2, G1-G3, plus the top inode

- **Unchanged from r9 (and r8):**
  - `relocate.py` (= r5, `2a037dae…`);
  - `config.subtree.production.template.json` (= r7/r8);
  - the journal: mode `subtree-r6`, same files, so **r6-r9 journals continue**;
  - the phases `plan` / `inventory-source` / `copy` / `verify` / `cutover` / `rollback`, the C1-C4 resume rules, and the floors, lane, ≤ 200 MiB/s, mount/path/hash pins;
  - R2 (bounded no-follow config, result and journal reads), and R3's scanner except as listed below;
  - there is still no deletion phase.
- **Changed:**
  - **B1:** the wrapper's staging copy (`dd iflag=nofollow,nonblock`, not `head`).
  - **B2:** the target walk (`walk_ids`).
  - **G1:** overlay mounts.
  - **G2:** per-thread mount namespaces.
  - **G3:** unknown fanotify mount marks.
  - **Targets:** each `dir` target gains `ino`.
  - **Format:** the result format is `nvme-cold-subtree-writer-check/r10`, and r8/r9 results are refused.
- **Tests:** `tests/test_subtree.py` (39 = r9's 34 + 5) and the unchanged `tests/test_relocate.py` (22), run by `jobs/tests.sh` under `unshare -Urn`.

## Root writer-check (read-only): the only way to run it
Root types or pastes this fixed wrapper. It contains **all three** sha256 pins.
1. **Bounded, no-follow copy:** each tool file is copied with `dd … iflag=nofollow,nonblock` (≤ 1 MiB; `timeout`) into a NEW root-owned 0700 `/run/nvme-cold-wc10.*`.
   - A symlinked stage file fails with `ELOOP` and is never opened (r9 B1).
   - A FIFO reads empty.
2. **Verify:** `sha256sum -c` of all three copies.
3. **Only then** `bash` the **staged** job. The job:
   - re-checks the Python pins, the dir (root 0700, `/run/nvme-cold-wc10.*`) and the files (root-owned, regular);
   - refuses unless MemAvailable ≥ 16384 + 1024 MiB;
   - execs `/usr/bin/python3 -I -B` from the staged copy.

**Root writes nothing except that temp dir,** which is removed on exit. The JSON goes to stdout, and the **owner's** shell redirect creates the result file. The scope caps memory at 1 GiB with no swap.

<!-- r10-root-wrapper -->
```bash
sudo systemd-run --scope --quiet -p MemoryMax=1G -p MemorySwapMax=0 -- bash -c 'set -euo pipefail; umask 077
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r10
W=$(mktemp -d /run/nvme-cold-wc10.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir -m 0700 "$W/jobs"
for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 dd if="$S/$f" of="$W/$f" bs=1048577 count=1 iflag=nofollow,nonblock,fullblock status=none; done
printf "%s  %s\n" 7bcd4fbff544b059e5ca882e5e97a6d4a989a3065abaad516f340e10ef19b635 "$W/jobs/root-writer-check.sh" 90cd8968b9f7c8446faf53aed3f51a0e39339ef17ede647e6ac7ff962ee955a3 "$W/subtree.py" 2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0 "$W/relocate.py" | sha256sum -c --quiet -
bash "$W/jobs/root-writer-check.sh" "$W" "$1"' nvme-cold-wc10 /ABSOLUTE/PATH/TO/CONFIG.json > RESULT.json
```
Then, as the owner (not root), record the result. This validates the exact keys, the r10 format, euid 0 and all three tool shas:
```bash
python3 -I -B /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r10/subtree.py record-writer-check --config /ABSOLUTE/PATH/TO/CONFIG.json --result RESULT.json
```

## What r10 changes in the scanner
- **B2: the target walk.**
  - `os.fwalk` is gone. It opened each subdirectory by name **without** `O_NOFOLLOW`/`O_DIRECTORY`, so root could open a swapped-in symlink or device. On a changed directory it also returned **silently**, dropping that subtree from the inode set while the scan stayed `complete`.
  - **The r10 walk is explicit and fd-relative:**
    - every subdirectory is opened `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC` relative to its parent's fd;
    - it must `fstat` to the `(dev, ino)` that was `lstat`ed;
    - a listing error, an open error or a replacement is a problem, so the scan is **incomplete**;
    - it holds O(depth) fds.
- **G1: overlay mounts.**
  - An overlay's real files are opened by the kernel, so a user's fd shows the overlay's dev and inode and cannot match.
  - Every `overlay` mount in every visible mount namespace is therefore checked. A `lowerdir`/`lowerdir+`/`datadir+`/`upperdir`/`workdir` layer makes the scan **incomplete** when it is:
    - at, under or above a target prefix;
    - relative, `/proc/…`, or escaped (`\`), i.e. not checkable by its path.
  - Layers elsewhere (Docker/containerd under `/var/lib/…`) are unaffected.
- **G2: per-thread mount namespaces.** A thread whose `task/TID/ns/mnt` differs from every namespace seen so far adds `task/TID/mountinfo` as a view, before that thread's fds are matched. Its aliases and mount ids then count.
- **G3: unknown fanotify mount marks.** A fanotify mount mark whose `mnt_id` is in no visible view makes the scan incomplete. It is never silently ignored.
- **The top inode:** every `state: "dir"` target has `ino` (int), for binding the scan to an exact tree top.

## Result format `nvme-cold-subtree-writer-check/r10` (the exact 18 keys, unchanged from r9)
| key | content |
|---|---|
| `format`, `t`, `tEnd`, `euid` | the format string; scan start (before the walk) and end (epoch s); euid (0) |
| `tools` | `{subtree.py, relocate.py, jobs/root-writer-check.sh: sha256}`: three keys |
| `prefixes` | `realpath(src)`, `src`, `.retire-*`, `dest` |
| `targets` | `[{class: source/retire/dest, subtree, path, state: dir/absent/symlink/unreadable, entries, majmin, dev, ino}]` (`majmin`/`dev`/`ino` only for `dir`; `target` for `symlink`) |
| `hits` | ≤ 1000 entries of `{pid, comm, where, how: inode/path, class, subtree, target}`; `hitsTotal` is the full count |
| `aliases`, `destAliases` | `[{ns, pid, mountId, point, root, exposesAt, class, subtree, path}]` |
| `nsCopies`, `fsWatchers` | same-path copies in other namespaces; filesystem/mount-wide fanotify marks on a target device |
| `incomplete`, `entries`, `complete` | `[[where, why]]`, the entry count, and `complete == (incomplete == [])` |
| `scan` | `{pids, raced, timeouts, namespaces, kcmpUnknown}` |
| `limitations` | the stated limitations (r10 wording) |

**Cut-over gate:** unchanged from r9, except that it requires the **r10** format. It needs:
- `complete`, `hits` empty and `hitsTotal` 0, no `aliases`;
- age within `writer_check_max_age_seconds`;
- the subtree's path in `prefixes`;
- this subtree's source walked (`dir`, `entries > 0`).

**R4 (unchanged):** writes through fds opened before the rename still go to `.retire-<name>`. Reclamation must prove the `.retire` identity equals the verified source identity.
