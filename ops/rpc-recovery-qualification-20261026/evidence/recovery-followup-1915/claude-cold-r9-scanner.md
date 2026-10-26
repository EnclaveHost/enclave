# nvme-cold-relocation-stage/r9: staged root dev+inode writer-check (r8 review R1-R3). FROZEN, NOT RUN

**Status (2026-10-26):**
- r9 is **frozen and consistent**: `SHA256SUMS` sha256 **`cc4d7cd373a22c2f37bf7c5cd26eae06a5e84a644363b8d508fa34b35e598f5d`**, `sha256sum -c` OK for all 8 files, all 0444, no `__pycache__`/`.pyc`.
- r8 is unchanged (`433fd131…`, verifies). r2-r7 and r1 are untouched.
- **What I did:** text edits, `ast.parse` and `bash -n` only.
- **What I did not do:** no test, build, sudo, mount, namespace, live scan, VM or production change. I did not edit 370's reclaim stage.
- **Not qualified:** root runs the tests (command below) once the KVM acceptance frees the queue. Nothing here claims a pass.

## Frozen files (pins for root and 370)
| file | sha256 | note |
|---|---|---|
| `subtree.py` | `ba716ac4d2cab04c07b6bcec41145cce3843864ea1d2dfff36bcef8983ec1086` | r9 |
| `relocate.py` | `2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0` | = r5/r8, byte-identical |
| `jobs/root-writer-check.sh` | `316f4e8e1554ce8b1edd0ab2d3e65330fa02f20557c92f0acd58ccbd38180218` | staged root job; pins the two Python shas |
| `tests/test_subtree.py` | `cf09abf1512395b2d1342c76887d5a9f4c40dd5529872078a04615498136f3f7` | 34 tests |
| `tests/test_relocate.py` | `dc597306da188b97f341c016f0b3f20f6f611be157aa0dbcc3e9001bd9c7d051` | = r5, 22 tests |
| `jobs/tests.sh` | `d58ad33fb6864a39d75e5520cacda8adaa3c9017a087801fec29e9b6fcdbb4d9` | |
| `config.subtree.production.template.json` | `93e516199000b342d4d70bf48c361696a848b7b773879985bed62390f0b9c535` | = r7/r8 |
| `README.md` | `d58c12d7b6d37e3cf8416a1b4042e471ba077bc83b6032dc7e4c7bbbd2bd1794` | contains the wrapper with all three pins |

## Root commands
1. **Tests.** Offline, in an **unprivileged user namespace**, which is required: two tests use the actual `/proc` and an actual child mount namespace.
   ```
   bash jobs/q-exit-status.sh cold-r9 512 unshare -Urn bash nvme-cold-relocation-stage/r9/jobs/tests.sh
   ```
   - **PASS** only with r5 `Ran 22 tests` OK **and** subtree `Ran 34 tests` OK, with no skips and `## cold-r9 rc=0`.
   - **Before running,** the job re-verifies the r1/r2-r8 freezes and checks that `relocate.py`, the r5 suite and the config template are byte-identical. It also refuses if not inside a user namespace or if a network route is present.
2. **Root writer-check** (live, read-only). This is the literal body for root to review and paste. Root never executes a uid-1000 file: all three executed tool files are copied with a bounded read into a new root-owned 0700 `/run` directory and sha-verified there **before** anything runs. Python is `/usr/bin/python3 -I -B` from that copy.
   ```bash
   sudo systemd-run --scope --quiet -p MemoryMax=1G -p MemorySwapMax=0 -- bash -c 'set -euo pipefail; umask 077
   S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/nvme-cold-relocation-stage/r9
   W=$(mktemp -d /run/nvme-cold-wc9.XXXXXXXX); trap "rm -rf -- $W" EXIT; mkdir -m 0700 "$W/jobs"
   for f in subtree.py relocate.py jobs/root-writer-check.sh; do timeout 20 head -c 1048577 -- "$S/$f" > "$W/$f"; done
   printf "%s  %s\n" 316f4e8e1554ce8b1edd0ab2d3e65330fa02f20557c92f0acd58ccbd38180218 "$W/jobs/root-writer-check.sh" ba716ac4d2cab04c07b6bcec41145cce3843864ea1d2dfff36bcef8983ec1086 "$W/subtree.py" 2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0 "$W/relocate.py" | sha256sum -c --quiet -
   bash "$W/jobs/root-writer-check.sh" "$W" "$1"' nvme-cold-wc9 /ABSOLUTE/PATH/TO/CONFIG.json > RESULT.json
   ```
   - **The scope:** `systemd-run --scope` (system binary) only bounds memory: 1 GiB, no swap. Root may drop that prefix and use plain `sudo bash -c '…'`; the body is identical. The scope creates a transient systemd unit, which is root-side runtime state; there is no file write by the tool.
   - **The staged job then:**
     - refuses unless the dir is `/run/nvme-cold-wc9.????????`, root 0700, not a link;
     - refuses unless the three files are root-owned regular files;
     - re-checks the Python pins;
     - refuses unless MemAvailable ≥ 16384 + 1024 MiB;
     - `exec env -i … /usr/bin/python3 -I -B "$W/subtree.py" writer-check --config CONFIG`.
   - **Writes:** none by root except `$W`, which is removed by the trap. The JSON goes to stdout and the owner's redirect creates `RESULT.json`.
   - **Owner record:** `python3 -I -B …/r9/subtree.py record-writer-check --config CONFIG --result RESULT.json`. It checks the exact keys, the format, euid 0 and the three tool shas.

## R1-R3 (what changed vs r8; everything else unchanged)
- **R1:** the wrapper above, and the job takes the staged dir as an argument (not `$0`). `tools` in the result now has **three** keys.
- **R2:** the config (≤ 64 KiB), the result (≤ 32 MiB, owner) and the journal `writer-check.json` are read as follows:
  - each is opened component-by-component with `O_NOFOLLOW` (directories `O_PATH|O_DIRECTORY`), and the file with `O_NOFOLLOW|O_NONBLOCK`;
  - `fstat` must show a regular file, the right owner, not group/world-writable, within the size bound;
  - each is parsed from that fd only;
  - a JSON/UTF-8 error is a typed refusal that echoes no content.
- **R3:** the target trees are walked with an fd-relative `os.fwalk` from a no-follow open: no symlink is followed, no other filesystem is entered, and each tree must be on its pinned filesystem. The walk collects the `(st_dev, st_ino)` of every entry of the **source, `.retire-*` and destination** trees of all three subtrees. These are matched against:
  - process and per-thread `cwd`/`root`/`exe`, via a bounded `stat` (5 s, helper thread);
  - every fd, via `fdinfo` `mnt_id` + `ino` mapped through that namespace's `mountinfo`, with a bounded-`stat` fallback for mounts not visible in any namespace;
  - unshared per-thread fd tables (`kcmp`; unknown → scanned);
  - `maps` dev:inode;
  - inotify and fanotify inode marks;
  - loop `backing_file` and swap files.

  Path-string matching is kept as before. Every visible mount namespace's `mountinfo` is read for aliases.

## API contract for 370 (reclaim r2): answers to A1-A12 in `logs/claude-cold-reclaim-r2.md`
| # | answer (frozen r9) |
|---|---|
| A1 | `format == "nvme-cold-subtree-writer-check/r9"`. **Exact key set (18):** `format, t, tEnd, euid, tools, prefixes, targets, hits, hitsTotal, aliases, destAliases, nsCopies, fsWatchers, incomplete, entries, complete, scan, limitations`. The r8 format is refused by r9 itself. |
| A2 | `euid == 0`. `tools` = `{"subtree.py": ba716ac4…, "relocate.py": 2a037dae…, "jobs/root-writer-check.sh": 316f4e8e…}`, i.e. **three** keys, all equal to the frozen SHA256SUMS above. |
| A3 | `t` = `env.now()` (`time.time()`) taken **before** the target walk; `tEnd` = after the scan. Both are host epoch seconds (float). |
| A4 | `targets[]`: one per `(class ∈ source/retire/dest, subtree)` for all three subtrees, i.e. 9 entries in `target_roots` order. Each is `{class, subtree, path, state ∈ dir/absent/symlink/unreadable, entries}`. `dir` adds `majmin` ("maj:min") and `dev` (int st_dev); `symlink` adds `target` (readlink). An `unreadable` target also appends to `incomplete`. |
| A5 | **`idsDigest` is NOT provided** (not added after freeze, to avoid scope growth). Bind on `entries` + `dev` + `majmin`, as your stated fallback. |
| A6 | `hits[]`: `{pid (str, or "kernel"), comm, where, how ∈ inode/path, class, subtree, target}`. Inode hits carry `class` (source, retire or **dest**) and `subtree`. Path-only hits have `class`/`subtree` = null and `target` is the readlink/maps/backing string. `hits` holds at most 1000 entries; `hitsTotal` is the full count. **Truncated means `hitsTotal > len(hits)`.** |
| A7 | **Confirmed, by path string only.** An fd on a deleted inode reads as `<path> (deleted)`. The ` (deleted)` suffix is stripped before prefix matching, and `prefixes` include `.retire-<name>` and the destination path, so it is reported as a `how: "path"` hit with `class`/`subtree` null. It cannot be inode-matched, because a deleted inode is not in any walked tree. A holder whose readlink string is **not** under a prefix (another mount namespace's path, or a bind alias) is **not** reported once the inode is deleted. See the limitations. |
| A8 | `aliases[]` (source/retire exposures at another path: these block r9's own cut-over) and `destAliases[]` (destination exposures: informational in r9). Both are `{ns, pid, mountId, point, root, exposesAt, class, subtree, path}`. |
| A9 | `fsWatchers[]`: `{pid, comm, where, mark}` where `mark` is the raw fanotify fdinfo line (≤ 200 chars, with `sdev:`/`mnt_id:`). **No separate `dev`/`majmin` field.** An entry is emitted **only** when that mark's device is one of the walked targets' devices (source or destination fs). So: **block on any non-empty `fsWatchers`.** |
| A10 | `complete == (incomplete == [])` exactly. |
| A11 | **Journal unchanged.** Mode `subtree-r6`, the same state fields (`cutover`, `verified.{source_identity, dest_identity, logical, t}`, `dest_identity_at_cutover`, `source_inventory.{identity, logical,…}`, `copy`, `dest_top`, `checksum`), the same file names, and unchanged path helpers `src_of`/`dest_of`/`retire_of`. **The one change:** r9's cut-over refuses an r8-format `writer-check.json` already in the journal. |
| A12 | R1/R2 as above. **Stated limitation:** the config path's **parent components** must contain no symlink (no-follow chain), otherwise it refuses. |

Other fields:
- `scan` = `{pids, raced, timeouts, namespaces, kcmpUnknown}`.
- `nsCopies` is an int.
- `incomplete` is `[[where, why]]`.
- `entries` is an int.
- `limitations` is a fixed list of strings.

## r9's own cut-over gate (`require_writer_check`)
r9 requires all of the following, otherwise it refuses:
- an r9 format result;
- `complete` true;
- `hits` empty **and** `hitsTotal == 0`;
- `aliases` empty;
- age within `writer_check_max_age_seconds`;
- the subtree's real path in `prefixes`;
- this subtree's `source` target walked (`dir`, `entries > 0`).

Any hit on **any** class, including destination and other subtrees, blocks, as in r8.

## Tests (34 subtree + 22 r5; prepared, NOT run)
- r8's 27 are kept, adapted to r9 shapes. W3 is replaced by the R1 wrapper test.
- **R1:** the README wrapper pins equal the actual shas of all three files, and the wrapper contains the staging, bounded read, sha check and staged exec. The job pins the two Python shas, ends in the exact `exec … python3 -I -B`, and has no chown/chmod/journal. Running the job against the stage dir, a missing `/run` dir or a tmp dir exits 2 with empty stdout.
- **R2 config:** each of the following is refused: a symlink, a `/dev/zero` symlink, a symlinked directory component, a FIFO (with an alarm guard: it must not block), 64 KiB+1, invalid JSON (the canary content is not echoed), and 0666.
- **R2 result/journal:** each of the following is refused: a FIFO result, a symlink result, an r8-format result, an oversized result, an r8 `writer-check.json` in the journal, `aliases`, missing targets, `hitsTotal` > 0, and a symlinked journal file. A valid r9 result passes.
- **R3 fixture:** `cwd` through a directory alias, an fd via `fdinfo` `mnt_id`+`ino` with a foreign path string, an inotify mark, an unshared thread fd table (bounded-stat fallback), `maps` dev:inode and a loop backing file are all `how: inode` hits. The r5/r8 path-string `scan_proc` finds **none** of them. The fixture namespace's extra mount appears in `aliases`. Record, then cut-over is refused.
- **R3 visibility:** a nested `NSpid`, a mount namespace held only by an fd, unreadable `maps` and a hung stat (0.2 s) each give `complete=false`. Recorded, cut-over is refused.
- **R3 actual (userns):**
  - the real `/proc` for pid 1 gives `complete=false` with `1 … PermissionError`;
  - **an actual child in its own mount namespace** bind-mounts a source subtree elsewhere, `cd`s there and holds a file open. This must give inode hits for `cwd` and `fd/*`, the fd target string under the alias (not under the source), and an `aliases` entry exposing the subtree at the bind point.
- **Walk:** no symlink is followed out of the tree; a symlinked component gives `unreadable`; the entry bound is enforced; a cut-over source gives `symlink`; a missing tree gives `absent`.

## Risks I could not verify (no execution)
- **Kernel details:**
  - the `errno` for `O_DIRECTORY|O_NOFOLLOW` on a symlink (`ENOTDIR` vs `ELOOP`): the code handles both;
  - the `fdinfo` `ino:` field (kernel ≥ 5.14; host 7.2);
  - the actual-alias test assumes the readlink of the child's fd shows the bind path. If the kernel shows otherwise, that assertion fails visibly; it is not skipped.
- **Test environment:** `TEST_TMP` must be on a filesystem whose `mountinfo` maj:min equals `st_dev`, e.g. ext4 on `/` (the r8 `runs/` location). On overlayfs the fixture scans would report "overmounted" and fail.
- **Nested `unshare --mount` + `mount --bind`** inside `unshare -Urn` is assumed available. If not, the test **fails**; it does not skip.
- **Live practicality is unmeasured:**
  - one bounded-stat thread per cwd/root/exe link (about 2 per thread);
  - one `fdinfo` read per non-pipe/socket fd;
  - a 5 s timeout per hung stat, aborting after 16;
  - target entries ≤ 2,000,000 (about 0.5 GB under the 1 GiB scope).

  Root should record its runtime and `scan` counters. Hosts with a mount namespace pinned only by an nsfs mount or fd make the scan `incomplete` by design.

## Remaining limitations (also in the result's `limitations`; none of them makes a missed writer harmless)
1. **Snapshot only.** A process that opens a target after its entries were read, or an fd in flight in an `SCM_RIGHTS` message, is not seen. A writer through an fd opened before the cut-over rename keeps writing into `.retire-<name>` (R4). Reclamation must therefore prove the `.retire` identity equals the verified source identity, and use a post-deletion confirmation scan. Missed writers are a **data-loss** risk, not harmless.
2. **Path-only coverage:** `io_uring` registered files, and deleted inodes after reclamation (A7).
3. **Kernel holders:** nfsd exports, BPF and similar are not enumerated. Loop and swap are.
4. **Not blocking in r9:** fanotify filesystem/mount-wide marks and destination aliases. They are reported; consumers such as reclaim may and should block on them.
5. **Visibility:** the scanner must run as real root in the initial PID and user namespaces. Anything less is `incomplete`.

## Next
An **independent review** of frozen r9, then root runs the tests. Production use comes only after that review and a PASS. There are no cut-overs or deletions, and no further features unless requested.
