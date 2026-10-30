# Cold reclaim r1: nvme-cold-reclaim-stage/r1 (PREPARED and FROZEN; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, builds, deletions, cut-overs, mounts, sudo, queue jobs or network, and changed no live state or config.
- r8 is untouched (`SHA256SUMS` `433fd131…` and r7 `0ee124ad…` re-verified; no bytecode in r8). I did not overlap review 1538.
- **Checks I made:** `ast` parse (3.12 grammar), `bash -n`, `json` parse, `sha256sum -c`.

**Read-only inputs:**
- **r8 journal** `~/.local/state/nvme-cold-subtree-r7`:
  - gguf-e2b: `copy: done`, verified (`dest_identity 88452a0d…`, `logical 7f993d7c…`), **not cut over**;
  - hf-convert and gvs5h: inventoried only.
- **Config** `logs/cold-subtree-production-1530.json`: sha256 `bae6021b…879f`; lane 536870912; writer-check age 120 s; floor 300 GB; journal `…/nvme-cold-subtree-r7`.
- **Tree shapes** (journal meta):
  - hf-convert: 24 files / 4 dirs, 158,749,500,752 B;
  - gvs5h: 6 / 2, 125,195,719,424 B;
  - gguf-e2b: 78 / 21, 43,957,352,504 B;
  - all uid/gid 1000, dirs 0755, **no symlinks, no hardlinks, no xattrs**, one device.
- **Live mounts** (`stat`, `/proc/self/mountinfo`):
  - `/vm` is the only mount of 253:1 (cryptvm ext4, root `/`), and nothing is mounted under the archive or `.cold-archive`;
  - the parent `…/2026-10-24/home` is steven 0755;
  - no `.retire-*` exists yet.
- **Queue:** `jobs/q-exit-status.sh` runs the command as the caller under the queue's memory guard.

## Stage
`nvme-cold-reclaim-stage/r1/`, `SHA256SUMS` = **`faa561cbe9a22a3c1d8ed17fd929929e0a034bc8cd5f8179babf3c07466ba559`** (all files `a-w`)

| file | sha256 |
|---|---|
| `reclaim.py` (480 lines) | `af3c415134c83caf6a03d9b2b4a6257efe3271ab3c6c101ce1e8aadc1d1c2de0` |
| `tests/test_reclaim.py` (10 tests) | `b6284c965afe42bb66128d3453f3805b3e8abe231e92b9a5a0de7ec44daecfda` |
| `jobs/tests.sh` | `14567797265bd00a6aaf3887a8cf544d20782f4416384502d51a4e35461eb982` |
| `config.reclaim.production.template.json` | `9de0c0c2b3480dad346d8cbae309fe4445cd90b61a4b41e9deecd20c36184fb2` |
| `README.md` | `40d8c3174c1c43f31d9b5d2eab67c63cb6e9e9a697013dc2f3328dd4fc816963` |

## Plan (per subtree, after that subtree's r8 cut-over is `complete`)
1. **r8, unchanged:** copy → verify → root scan + `record-writer-check` → `cutover`. The original becomes `.retire-<name>`, and the original path becomes r8's symlink to the destination.
2. **`reclaim.py verify`** (owner, queue lane): fresh FULL destination hash plus every state check, which writes the receipt with the exact deletion plan.
3. **Root, read-only:** a fresh complete `/proc` scan with **r8's frozen stdout scanner** (`r8/jobs/root-writer-check.sh`, unchanged). This is the only sudo step.
4. **`reclaim.py reclaim`** (owner, queue lane) with the explicit exact `.retire` path and that scan: identity-checked, per-entry deletion of exactly the plan.
5. **`reclaim.py check-retained`:** the retained destination re-hashed in full against the receipt.

**Recovery copy and rollback stay available until step 4 starts.**
- r8 `rollback` restores the original (keeping the destination) up to then, which the tests demonstrate.
- After the reclaim, the destination is the copy.

## Design: what the tool refuses on
**Reuse without overlap:**
- `reclaim.py` loads r8's `subtree.py` by **sha-pinned compile + exec** (`4509e043…`; that in turn loads `relocate.py` `2a037dae…` the same way). It never imports r8 through the import system and never loads a pyc.
- It only **reads** the r8 journal, and holds r8's journal flock during verify/reclaim so no r8 phase (copy/cutover/rollback) can run concurrently. It writes only its own 0700 journal on `/` (`~/.local/state/nvme-cold-reclaim-r1`).

**Every phase but status:**
- Runs as the owner (root refused in production) inside the queue lane: exact cgroup `memory.max`, MemAvailable ≥ 16 GiB at start, and the queue guard's continuous 16 GiB floor.
- `/` must be ≥ its 300 GB floor; `/` is never written beyond journal and receipt files.
- **Config:** loaded through r8's own `load_config`, with r8's production pins. The reclaim config pins the **sha256 of the exact r8 config file**. In production the reclaim journal path, r8 journal path and owner uid 1000 are pinned.

**Gates (before the reclaim journal is created):**
- **Mounts:** source mount, destination mount, and journal on `/` per the pins.
- **Exactly one mount of the source filesystem** (same major:minor), at `/vm` with root `/`. A second view would escape the path-based `/proc` scan.
- **No mount point** inside the original path, the retired tree or the destination.
- **Devices:** the retired tree is on the source device; the destination and reclaim journal are on `/` and not on the source.

**`verify`:**
- **r8 journal:**
  - `cutover == complete`; anything else (`renaming`, `renamed`, none) refuses;
  - `verified.source_identity == source_inventory.identity` and the logical equals the inventory's;
  - `dest_identity_at_cutover` is present.
- **Paths:**
  - the original path is a symlink with `readlink == realpath ==` the destination, with no symlink components;
  - the destination is the owner's directory in the 0700 tree;
  - the retired tree is the owner's real directory under a symlink-free parent.
- **Rename ctime is accounted for:** `identity(walk(.retire))` must equal r8's verified source identity.
  - That identity includes dev/ino of every entry and **every child's ctime**, plus sizes, mtimes, modes and link targets.
  - r5's walk excludes only the top directory's own ctime, which is exactly what the cut-over rename changes. So the renamed inode tree must be byte-for-byte the verified one.
- **Plan:** regular files with `nlink == 1` and directories only, all owned by the owner, ≤ 100,000 entries. A symlink, hardlink, other owner, fifo/socket/device, or nested mount refuses.
- **Destination:**
  - `identity_now == dest_identity_at_cutover`, so nothing was written through the symlink;
  - then **every file is read and hashed now**: a NEW cache path, `reused == 0`, `hashed == files`, and the walk is unchanged during hashing;
  - the logical must equal r8's verified logical; the manifest sha256/bytes per entry must match; manifest links must resolve into the destination; top modes must be equal.
- **Receipts:** `verify-<name>.json` (the plan, identities, counts; its sha256 is recorded in state) and `dest-<name>-<run>.logical.json` (per-file sha256 of the retained copy).

**`reclaim --result SCAN --reclaim-retired <exact path>`:**
- **Explicit:** `--reclaim-retired` must equal `…/2026-10-24/home/.retire-<name>` exactly. The receipt must hash to the recorded sha. The destination identity and manifest links are re-checked.
- **Scan (r8's root stdout JSON):**
  - a regular owner file, not group/world-writable, with exactly r8's 9 keys;
  - `format` r8, `euid 0`, `tools == {subtree 4509e043…, relocate 2a037dae…} ==` the files on disk;
  - `complete` with nothing unreadable;
  - taken **after** the verify receipt, ≤ `writer_check_max_age_seconds` (120 s) old, not from the future, and **single-use** (`t` must exceed every scan already used);
  - its prefixes must cover this `.retire` and original path.
- **Per-tree blocking:** a hit (fd/cwd/root/exe/maps/loop/swap) inside **this** `.retire` path or the original path blocks this subtree only. Hits elsewhere (other trees, or live use of the destination) are counted, not blocking. Unrelated apps never need stopping.
- **First run:** the receipt must be ≤ `verify_max_age_seconds` old, and the walk of the `.retire` tree must equal the receipt's plan **exactly**; otherwise refuse with nothing deleted. Then state `deleting` is saved.

**Deletion:**
- Through directory fds: the parent is opened `O_DIRECTORY|O_NOFOLLOW` and must be on the plan's device; the top is opened by name relative to it, and its dev/ino/mode/owner are checked.
- **Pass 1 validates everything still present without deleting.** Any **unrecognized** name, or any changed entry, refuses before anything in that run is removed.
- **Pass 2** re-checks each entry and only then removes it:
  - `unlinkat` a planned file only if dev/ino/ctime/size/mtime/mode/owner and `nlink == 1` all equal the plan;
  - `rmdirat` a planned directory only if dev/ino/mode/owner match and it is empty (the kernel refuses a non-empty `rmdir`). Directory mtime/ctime are not compared, because the deletion itself changes them.
- **The top goes last:** state `rmdir-top` is saved first, the top must be empty, then `rmdir`.
- Every unlink and rmdir is fsync-journalled with inode and bytes.
- **No recursive rm, no wildcard, no path outside the plan, and nothing under the destination.**

**Crash and resume:**
- An `OSError` mid-way leaves `deleting`. A re-run (with a fresh scan) passes the same per-entry checks; already-removed planned entries are simply absent, and unrecognized or changed ones refuse.
- `rmdir-top` with the top already gone completes. `deleting` with the top gone refuses (manual review).
- An entry removed but not yet journalled (SIGKILL between the two) only makes the journalled count lower. The receipt is still correct: the tree is gone, and the counts can only fall short.

**Receipt** `reclaimed-<name>.json`:
- journalled files/dirs/bytes vs the plan;
- source free space before/after;
- the retained destination identity and logical (with the per-file file);
- the verify-receipt sha and the scan files used;
- post-checks: `.retire` absent, destination unchanged, symlink and manifest links resolve.

A failed post-check or an over-count refuses (rc 3) after recording.

## Recovery after reclaim
- The destination `/home/steven/.cold-archive/codex-archive/<rel>` is then **the** copy. The original path stays r8's symlink to it, and every manifest/home link keeps resolving.
- **`check-retained --subtree S`** re-hashes it in full against the reclaim receipt's logical. Run it any time; it refuses loudly on any difference.
- **Moving the data back to `/vm`**, if ever needed, would be a separately reviewed reverse copy; r1 implements none of it:
  1. `rsync -aHAX` the destination to a new `/vm/…/.restore-<name>`;
  2. verify it against `dest-<name>-<run>.logical.json`;
  3. a reviewed symlink→directory swap.
- **r8 `rollback` after reclaim fails closed** ("`.retire-<name>` is missing: manual review"), which the tests demonstrate.
- **Do not re-run r8 `cutover` on a reclaimed subtree:** its `post_checks` would `lstat` the missing `.retire` and raise.
- The destination is on one disk (cryptroot). Any off-host backup is outside this stage.

## Failure tests (10, not run)
The tests drive the **real frozen r8** phases on temp fixtures: inventory (1381 reuse / `--fresh-hash`), rsync copy, verify, root scan on stdout, record, cutover. FakeEnv supplies mounts, lane, memory, free space and `/proc`.

1. **Full reclaim of one tree:**
   - removals happen only via `dir_fd` unlink/rmdir (3 files, 4 dirs) and `shutil.rmtree` is never called;
   - the destination tree is byte-identical (inode/size/mtime/ctime), the original symlink and the manifest link still resolve, and the other two subtrees are unchanged;
   - all receipts exist and balance; a second `reclaim` reports `already`; `check-retained` re-hashes all 3 files;
   - r8 `rollback` now refuses and changes nothing.
2. **r8 state:** no cut-over refuses; `cutover: renamed` refuses; missing `verified` refuses. Before reclaim, r8 rollback works, and reclaim then refuses.
3. **Fresh content hash:** the destination bytes are changed with size and mtime kept, and the identity pin is adjusted to model corruption that metadata does not show. `verify` refuses "content differs"; there is no receipt, and nothing is deleted.
4. **Changed states refuse with nothing deleted:**
   - an unknown file added to `.retire` after verify;
   - the same file removed and the mtime restored (the child ctime still differs, so it still refuses);
   - a file written to the destination after verify;
   - a tampered receipt.
5. **Scan gates:** missing scan; incomplete; euid 1000; wrong format; wrong tool sha; prefixes not covering; `t` older than the receipt; age > 120 s. A fake `/proc` process with its cwd in gguf-e2b's `.retire` **blocks gguf-e2b only**, while gvs5h reclaims in the same state; once that process is gone, gguf-e2b reclaims.
6. **Crash mid-delete** (`EIO` on the 2nd unlink):
   - state `deleting`, and the used scan is refused on replay;
   - a planted unknown file refuses, and nothing is deleted;
   - a new inode under an already-removed planned name refuses and stays;
   - a clean resume completes (journalled 3 files across runs).
7. **Crash at the top `rmdir`:** state `rmdir-top`; a late unknown file refuses and stays; then the resume completes.
8. **Mounts, devices, symlinks and gates refuse, and the tree stays intact:**
   - a nested mount; a second mount of the source filesystem; a source not mounted at root `/`; wrong mount pins;
   - the destination on the source filesystem;
   - `/` below the floor; the wrong queue lane; MemAvailable 16 GiB − 1;
   - a wrong `--reclaim-retired`; a symlink substituted for `.retire` (its target untouched);
   - root in production; an r8 config sha mismatch.
9. **Hardlinks:** a hardlinked tree (via r8 `--fresh-hash`) is refused at verify.
10. **Stage:** the r8 shas on disk equal the pins, and `reclaim.py` contains no `rmtree`/`os.system`/`subprocess`/`glob`/`shell=True`/`os.walk(`.

## Root handoff (after review; per subtree, only when its r8 cut-over is complete)
**Prerequisites:**
- review 1538 accepts r8's `jobs/root-writer-check.sh`;
- `cold-reclaim-r1` tests pass;
- a reclaim config (from the template) filled with `subtree_config` = the exact r8 config, its sha256 (observed `bae6021b…879f`), and `verify_max_age_seconds`;
- `umask 077` for the scan files.

```
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; cd $W
bash jobs/q-exit-status.sh cold-reclaim-r1 512 unshare -Urn bash nvme-cold-reclaim-stage/r1/jobs/tests.sh
# per subtree, e.g. S=2026-10-24/home/gguf-e2b N=gguf-e2b; RC=<reclaim config>; C8=$W/logs/cold-subtree-production-1530.json
bash jobs/q-exit-status.sh reclaim-verify-$N 512 python3 -I -B nvme-cold-reclaim-stage/r1/reclaim.py verify --config $RC --subtree $S
sudo bash nvme-cold-relocation-stage/r8/jobs/root-writer-check.sh $C8 > $W/logs/reclaim-scan-$N.json        # owner's redirect
bash jobs/q-exit-status.sh reclaim-$N 512 python3 -I -B nvme-cold-reclaim-stage/r1/reclaim.py reclaim --config $RC --subtree $S \
     --result $W/logs/reclaim-scan-$N.json --reclaim-retired /vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-$N
bash jobs/q-exit-status.sh reclaim-check-$N 512 python3 -I -B nvme-cold-reclaim-stage/r1/reclaim.py check-retained --config $RC --subtree $S
```
- **Lane:** 512 MiB matches the config's `queue_lane_bytes` 536870912.
- **Timing:** the scan has 120 s to be used. If the queue delays the start, `reclaim` refuses "stale"; take a new scan and re-run.
- **Sequencing:** run verify and reclaim when no r8 phase is running, because they hold r8's journal lock and r8 refuses instead of waiting. Every other `.retire` stays untouched.

## Limitations (stated, not fixed)
- **The path-based `/proc` scan is r8's, unchanged.** A process in another mount namespace that sees `/vm` under a different path would not match its prefixes.
  - Mitigated: one mount of the source filesystem in the host namespace; the trees are cold archives with hidden `.retire-*` names, and nothing references them (manifest links go via the symlink).
  - The consequence of a miss is limited: that process keeps its open fd (the inode lives until close), and the data still exists in the destination.
  - An inode-based root scanner (stat each fd and compare dev/ino with the plan) would close this. It is a separate root handoff and review, so it is not done in r1.
- **Race windows** (≤ 120 s): the scan to the deletion start; and per-entry check to unlink by name within a directory fd. Only uid 1000 (same trust) or root can act in those windows; directories are owner-owned 0755.
- **Content of the original** is not re-hashed; only the destination is. Its equality rests on the unchanged identity, including ctimes, since root's full 1381 hash and r8's verify. The reclaim deletes it anyway.
- **Unrelated symlinks into `.retire-*`** outside the manifest cannot be enumerated without a full filesystem walk. None are expected: the name is created by r8's cut-over.
- **Reclaimed space** is reported from statvfs before and after. Space held by an inode still open elsewhere is freed only on close.

## Capacity
- **After all three:** about 327.9 GB returns to `/vm` (158.7 + 125.2 + 44.0 GB). That is `/vm` about 407.8 GB, about 21.9 GB above the qualification threshold 385,899,345,920.
- **Qwen padbank:** it can still grow by about 64 GB; if it resumes, that margin is lost.
- **`/` is unaffected** by reclaim (about 498 GB after the copies, per 1530/1531). The 300 GB floor is still enforced at every phase.
- **Production thresholds:** none of the production VM's prepare/controller/guard thresholds are read or changed.
