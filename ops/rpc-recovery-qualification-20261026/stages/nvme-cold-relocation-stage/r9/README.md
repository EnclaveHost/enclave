# nvme-cold-relocation-stage/r9 (PREPARED by Claude; nothing run): r8 + the r8 review R1-R3 (root scanner boundary and completeness)

- **Unchanged from r8:**
  - `relocate.py` (= r5, `2a037dae…`);
  - `config.subtree.production.template.json` (= r7/r8);
  - the journal: mode `subtree-r6`, format and file names unchanged, so **r6/r7/r8 journals continue**;
  - the phases `plan` / `inventory-source` / `copy` / `verify` / `cutover` / `rollback`;
  - every C1–C4 resume rule;
  - the floors, lane, ≤ 200 MiB/s, mount/path/hash pins;
  - there is still no deletion phase.
- **Changed:** `writer-check` (root), `record-writer-check` and the cut-over gate on the recorded result. Config and result reads are bounded.
- **Tests:** `tests/test_subtree.py` (34) and the unchanged `tests/test_relocate.py` (22), run by `jobs/tests.sh` under `unshare -Urn`.

## R1: root never executes a uid-1000 file
Root runs the scan **only** with this fixed wrapper, typed or pasted by root. It contains **all three** sha256 pins:
- a bounded copy (≤ 1 MiB each; `timeout` against a FIFO) of `subtree.py`, `relocate.py` and `jobs/root-writer-check.sh` into a NEW root-owned 0700 `/run/nvme-cold-wc9.*`;
- `sha256sum -c` of all three copies;
- only then `bash` of the **staged** job, which re-checks the Python pins, the dir (root 0700, `/run/nvme-cold-wc9.*`) and the files (root-owned, regular, not symlinks), and execs `/usr/bin/python3 -I -B` from the staged copy (`relocate.py` loaded by compile+exec of its verified bytes; no pyc read or written).

Root writes nothing except that temporary dir, which is removed on exit. The JSON goes to stdout and the **owner's** shell redirect creates the result file.

**Memory:**
- The scan runs in a transient root scope with `MemoryMax=1G` and no swap. It keeps one `(dev, ino)` per target entry, at most 2,000,000 entries (about 0.5 GB).
- The staged job refuses to start unless host MemAvailable ≥ 16384 + 1024 MiB, which preserves the 16 GiB host floor.
- It is not run in the user queue lane, because it must be root.

<!-- r9-root-wrapper -->
```bash
sudo systemd-run --scope --quiet -p MemoryMax=1G -p MemorySwapMax=0 -- bash -c 'set -euo pipefail; umask 077
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r9
W=$(mktemp -d /run/nvme-cold-wc9.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir -m 0700 "$W/jobs"
for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 head -c 1048577 -- "$S/$f" > "$W/$f"; done
printf "%s  %s\n" 316f4e8e1554ce8b1edd0ab2d3e65330fa02f20557c92f0acd58ccbd38180218 "$W/jobs/root-writer-check.sh" ba716ac4d2cab04c07b6bcec41145cce3843864ea1d2dfff36bcef8983ec1086 "$W/subtree.py" 2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0 "$W/relocate.py" | sha256sum -c --quiet -
bash "$W/jobs/root-writer-check.sh" "$W" "$1"' nvme-cold-wc9 /ABSOLUTE/PATH/TO/CONFIG.json > RESULT.json
```
Then, as the owner (not root), record the result into the journal. This validates the exact keys, the format, euid 0 and all three tool shas:
```bash
python3 -I -B /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r9/subtree.py record-writer-check --config /ABSOLUTE/PATH/TO/CONFIG.json --result RESULT.json
```

## R2: bounded, no-follow reads
The config (≤ 64 KiB), the result file (≤ 32 MiB, owner-owned) and the journal's `writer-check.json` are read as follows:
- **Opening:** every path component is opened relative to its parent with `O_NOFOLLOW` (directories `O_PATH|O_DIRECTORY`), and the file with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC`. A symlink anywhere refuses, and a FIFO cannot block.
- **Checks:** `fstat` must show a regular file, not group/world-writable, owned by the owner or root (config, journal) or by the owner (result), within the size bound.
- **Parsing:** the content is parsed from that fd only.
- **Errors:** a JSON/UTF-8 error is a typed refusal that echoes no content.

## R3: writer-check by device + inode
1. **Target walk:** every entry of the three source trees, the `.retire-*` trees and the destination trees.
   - The walk is fd-relative (`os.fwalk`) from a no-follow open, so no symlink is followed anywhere.
   - It records `(st_dev, st_ino)` and never enters another filesystem; a mount inside a tree makes the scan incomplete.
   - Each tree's filesystem must be the pinned one (overmount → incomplete). A cut-over source shows as `symlink`; a missing tree as `absent`.
2. **Processes and threads** (`/proc`), each matched by `(dev, ino)` and also by path string as before:
   - `cwd`, `root` and `exe`, plus every thread's `cwd`/`root`, through a bounded `stat` of the magic link (a helper thread with a 5 s timeout; a hang → incomplete);
   - every fd, via `fdinfo` `mnt_id` + `ino` mapped through that mount namespace's `mountinfo`, with no access to the file's filesystem; a mount in no visible namespace (detached or lazily unmounted) falls back to the bounded `stat`;
   - per-thread fd tables that `kcmp(KCMP_FILES)` does not show as shared (unknown → scanned too);
   - `maps` dev:inode columns;
   - inotify and fanotify inode marks (`fdinfo` `ino`/`sdev`); fanotify filesystem/mount marks on a target device go to `fsWatchers`;
   - `io_uring` registered files, by path only.
3. **Kernel holders:** loop `backing_file` and swap files, by path and by `(dev, ino)` of the resolved path (unresolvable → incomplete).
4. **Mount namespaces:** every visible mount namespace's `mountinfo` is read.
   - A mount of a target's filesystem that exposes a **source/.retire** tree at another path is an `aliases` entry, which **blocks cut-over**.
   - The same for a destination tree is `destAliases` (informational).
   - Same-path copies in other namespaces are only counted (`nsCopies`).
5. **Incomplete visibility:** each of the following makes `complete = false`, which blocks cut-over:
   - any unreadable entry (e.g. `PermissionError`: a root without `CAP_SYS_PTRACE` in the initial user namespace);
   - a scanner outside the initial PID namespace (`NSpid`);
   - a mount namespace held only by an fd or an nsfs mount;
   - a hung `stat`;
   - more than 4,000,000 `/proc` entries or 2,000,000 target entries.

   Processes or fds that vanish mid-scan are counted (`scan.raced`), not hidden.
6. **Stated limitations** (in the result's `limitations`):
   - it is a snapshot;
   - SCM_RIGHTS in-flight fds are not seen;
   - kernel holders beyond loop and swap are not enumerated;
   - fanotify filesystem/mount marks and destination aliases are not blocking.

**Cut-over gate:**
- **Requires** an **r9** result (an r8 path-string result in an r7/r8 journal is refused) that is `complete`, with `hits` empty and `hitsTotal` 0, no `aliases`, within `writer_check_max_age_seconds`, listing the subtree's path, with this subtree's source tree walked (`state dir`, `entries > 0`).
- **R4 (unchanged scope):** writes through fds opened before the rename still go to `.retire-<name>`. Reclamation must prove `.retire` identity == the verified source identity.

## Result format `nvme-cold-subtree-writer-check/r9` (exact keys)
| key | content |
|---|---|
| `format`, `t`, `tEnd`, `euid` | format string, scan start and end (epoch s), euid (0) |
| `tools` | `{subtree.py, relocate.py, jobs/root-writer-check.sh: sha256}` |
| `prefixes` | the r8 string prefixes: `realpath(src)`, `src`, `.retire-*`, `dest` |
| `targets` | `[{class: source/retire/dest, subtree, path, state: dir/absent/symlink/unreadable, entries, majmin, dev}]` |
| `hits` | ≤ 1000 entries of `{pid, comm, where, how: inode/path, class, subtree, target}`; `hitsTotal` is the full count |
| `aliases`, `destAliases` | `[{ns, pid, mountId, point, root, exposesAt, class, subtree, path}]` |
| `nsCopies`, `fsWatchers` | same-path copies in other namespaces; filesystem/mount-wide fanotify marks on a target device |
| `incomplete`, `entries`, `complete` | `[[where, why]]`, the entry count, and whether the scan was complete |
| `scan` | `{pids, raced, timeouts, namespaces, kcmpUnknown}` |
| `limitations` | the stated limitations |
