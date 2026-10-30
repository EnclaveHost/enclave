# /vm capacity next step (task 1510): quickest reversible cold relocation, read-only plan (2026-10-26)

**Status:**
- Read-only planning. No tests, mutation, network, hash or du scans, or live commands.
- **Sources read:** existing records only:
  - `nvme-capacity-audit-stage/` (REPORT.md, `du*.txt`, `times.txt`, `backing.txt`, `openfiles.txt`; audit 2026-10-25T17:06Z);
  - `nvme-cold-relocation-stage/relocate.py` (+ r2-r5);
  - root 1380 (plan), 1381 (archive inventory) and 1401 (`.pixel10` inventory);
  - the cold model move records `logs/cold-model-copy-1497.json` and `logs/cold-model-relocate-1505.json`.
- **Not touched or proposed:** the Qwen padbank (485 GB, live), VM disks, active source/recovery copies.

## Target
- **`/vm` free now:** 79,900,258,304 B (1505 receipt).
- **Requirement:** 385,899,345,920 B (qualvm r4 admission = production-guard pause threshold 368,719,476,736 + 16 GiB).
- **So relocate ≥ 305,999,087,616 B** (≈ 306 GB), counted as freed **allocated** bytes on `/vm`.
- The reserve is not lowered.

## What the records establish
- **`codex-archive` is NOT cold as a whole.** It is the live backing store of the home trees:
  - **1380:** "2102 manifest symlinks resolve into the archive";
  - **the audit:** 1,194 archive files, 743.4 GiB, are reached by absolute symlinks from `~/Documents/Codex/2026-09-04` (960), `~/Documents/Codex/2026-09-07` (103), `~/gguf-e2b` (78), `~/hf-convert` (24), `~/Projects/enclave/.consolidation` (23) and `~/gvs5h` (6);
  - it is probably the **only** copy of those files, because the home originals became symlinks.
  - **So:** any move must keep every target path resolving. Nothing here is "cold" from its mtime (newest data mtime 10-24/10-25; atime is useless after the 10-24 build).
- **1381 succeeded:** `codex-archive`, 2,480 entries, 2,128 files hashed, 987,035,811,891 B, identity `d3f4775f…`, logical `fb369205…`.
  - **The archive structure is simple:** one filesystem, 0 hardlinks, 0 symlinks, 0 sparse, 0 `.git`, inner modes 644/755/600.
  - **Confidentiality rests on the top-level 0700.**
- **`.pixel10/tensor-sdk` (997.7 GiB) is the harder tree:**
  - its inventory (1401) was killed at 256 MiB (`EXIT -15`, partial cache);
  - it has 543 hardlinked inodes (a copy without `-H` adds 149.7 GiB), 2,324 symlinks (147 pointing outside), and 76 `.git`;
  - its worktree pointers go through the home symlink path;
  - it is mode 0755.
  - **Not the quickest route.**
- **`relocate.py` (r2-r5, reviewed) is pinned** to whole-tree relocation of exactly `codex-archive`/`.pixel10` into a NEW ext4 **image on the USB RAID**. It needs the local sudo loop mount (the known barrier) plus a ROOT writer-check.
  - **Reusable, already reviewed:**
    - the inventory (1381 hashes);
    - `rsync -aHAX --numeric-ids --one-file-system --bwlimit`;
    - the verify (type, mode, owner, size, mtime, xattr, hardlink groups, sha256);
    - the cutover by `rename → .retire-<name>` plus a symlink, with automatic rollback;
    - **no deletion phase:** reclamation is separately reviewed.
- **The NTFS route (1497/1505)** worked for one 21 GB `.gguf`: verified sha256, path preserved, mtime rounded to 100 ns.
  - **Measured speed:** ~43 MB/s (492.7 s for 21.2 GB).
  - **The USB mount is `ntfs3 uid=1000,gid=1000,dmask=0022,fmask=0022`**: every file 0644 and every directory 0755, so world-readable, with modes, owners and exec bits flattened.

## Recommendation: a subtree move to the root filesystem (T500 `/`, ext4 on `cryptroot`) with a directory symlink
**Candidate set:** all under `/vm/enclave-volumes/codex-archive/2026-10-24/home/`. Sizes are allocated bytes from the audit `du`, B, not re-measured.

| subtree | bytes | inbound home links (audit) | content (by suffix) |
|---|---|---|---|
| `hf-convert` | 158,749,671,424 | `~/hf-convert` 24 | `.gguf`/bf16/`src` model conversions |
| `gvs5h` | 125,195,780,096 | `~/gvs5h` 6 | `model/` |
| `gguf-e2b` | 43,957,686,272 | `~/gguf-e2b` 78 | `tpu/` and model files |
| **total** | **327,903,137,792** | 108 | ≥ 305,999,087,616 needed, **margin ≈ 21.9 GB** |

**Why this route:**
- **Fast:** NVMe → NVMe on the same machine (≈ minutes, not days), with an explicit `--bwlimit` so the live Qwen padbank IO on `/vm` is not starved.
- **Metadata-exact:** ext4 → ext4 keeps mode, owner, nanosecond mtime and xattrs.
- **Confidential:** encrypted (`cryptroot`), under a 0700 parent.
- **No sudo** for the copy: everything is uid 1000.
- **No path breaks:**
  - the subtree on `/vm` becomes `.retire-<name>` (same-fs rename, instant), and a symlink at the old path points to the `/` copy;
  - the 108 home links are absolute paths *through* the subtree directory, so they keep resolving;
  - a reader with an open fd stays on the old inode (kept in `.retire` until reclamation).
- **Reversible:** before reclamation, rollback is: remove our symlink, rename back. After reclamation: copy back `/` → `/vm` (fast, same tools).
- **Why these subtrees and not the others:** they hold self-contained model artifacts behind three dedicated home roots, separate from the chain/enclave work.
- **Avoided:**
  - `home/Projects/enclave` (273.9 GiB; 174.1 GiB of `shielded` `.pads` that no symlink reaches, so its readers are unknown; it is the active project);
  - `2026-09-04/lo/work` (`eyesoff-perf` `.pads`, possibly related to padbank work);
  - `2026-09-07/i-w/work`;
  - `.pixel10`.
- **Fallback set if a candidate fails its checks:** `2026-10-24/2026-09-07/i-w/work` (167,908,646,912 B) + `hf-convert` (158,749,671,424 B) = 326.66 GB. Only with the same checks.

**Capacity:**
- `/` has about 770 GiB = 826.8 GB free; after 327.9 GB it has about 498.9 GB.
- If `/` keeps the same 300 GB operational floor as the audit's plan, that is a margin of ≈ 198.9 GB. **Root must confirm the `/` floor and its other consumers.**
- `/vm` after **reclamation** ≈ 79.90 + 327.90 = **407.8 GB ≥ 385.9 GB**.
- **Space is freed only when the `.retire-*` trees are deleted** (the separately reviewed reclamation step). Copy and cutover alone free nothing.

**The NTFS verified copy with a maintained link is NOT suitable here:**
- it is world-readable (it breaks the archive's 0700 confidentiality);
- it flattens modes and owners;
- it is about 43 MB/s, so ≈ 2.1 h for 328 GB, on the same USB RAID the Base state fetch uses;
- mtimes are rounded.

It was acceptable for one public model file; not for an archive subtree.

## Barriers (must be cleared by root; none can be waived)
1. **Tooling:** `relocate.py` r5 does not do subtrees or a directory destination on `/`. The minimal reviewed delta (r6) is:
   - source = exactly these subtree paths;
   - destination = `/home/steven/.cold-archive/codex-archive/2026-10-24/home/<name>` under a 0700 `.cold-archive`, checked to be ext4 on `cryptroot`, same uid, `--one-file-system`;
   - reuse 1381's source sha256 for unchanged identities, so only the destination is hashed;
   - verify, cutover, rollback and **no deletion** unchanged.
   - **Not yet written or reviewed.**
2. **Writers and readers:** the audit's own-uid scan was incomplete (41 unreadable own-uid processes, 534 other-uid processes). r5's cutover requires a FRESH, **complete ROOT** writer-check with zero hits. That still needs root privilege, but only a **read-only** `/proc` scan, not a mount.
3. **The live Qwen process:** it must be shown not to map or open any file under the candidates. A model `.gguf` under `hf-convert`/`gvs5h`/`gguf-e2b` could be its weights. An open mapping does not break at cutover, but would forbid reclamation.
4. **Unchanged since 1381:** the identities of everything under the candidates must equal the 1381 inventory (mtime/ctime/size/ino). Otherwise re-inventory those subtrees, which is bounded: ~328 GB to read once.
5. **Capacity on `/`:** confirm the `/` floor and consumers before the copy.

## Concrete next read-only checks for root (metadata only; no hashes, no du)
1. **Free space and filesystems:** `df -B1 /vm /`, and `findmnt -no SOURCE,FSTYPE,OPTIONS /vm /`. Expect ext4 on `cryptvm`/`cryptroot`.
2. **Nothing changed since the archive build:**
   ```
   find /vm/enclave-volumes/codex-archive/2026-10-24/home/{hf-convert,gvs5h,gguf-e2b} -xdev \( -newermt '2026-10-25 04:00Z' -o -newerct '2026-10-25 04:00Z' \) -printf '%TFT%TT %CFT%CT %p\n' | head -50
   ```
   Expect no output. Any output means the subtree is not closed: drop it.
3. **Ownership and types:** `find <same> -xdev \( ! -uid 1000 -o -type l -o \( ! -type f ! -type d \) -o -links +1 \) -print | head`. Expect nothing (the audit found none: no foreign owner, symlink, special file or hardlink).
4. **Inbound links:**
   - list the archive's relocation manifest entries (`2026-10-24/recovery-documents/artifact-relocation-manifest.json`; reading its JSON is metadata) whose targets fall under the three subtrees;
   - then `find ~ -xdev -type l -lname '/vm/enclave-volumes/codex-archive/2026-10-24/home/*' -printf '%p -> %l\n' | wc -l`. Expect ≈ 108 (audit: 24 + 6 + 78), and no link elsewhere into these subtrees.
5. **Live readers/writers, AS ROOT, read-only:**
   ```
   sudo find /proc/[0-9]*/{fd,cwd,root,exe} /proc/[0-9]*/task/*/fd -lname '/vm/enclave-volumes/codex-archive/2026-10-24/home/*' 2>/dev/null
   sudo grep -l ' /vm/enclave-volumes/codex-archive/2026-10-24/home/' /proc/[0-9]*/maps 2>/dev/null
   ```
   Also with the `~/hf-convert`, `~/gvs5h` and `~/gguf-e2b` link roots (an opened symlink shows the resolved `/vm` path). Expect zero hits. **Specifically record the Qwen process's** `cmdline` and `maps` model paths.
6. **References:**
   ```
   grep -rlE 'hf-convert|gvs5h|gguf-e2b' ~/.config/systemd/user ~/.local/share/systemd/user /etc/systemd/system ~/.config/autostart 2>/dev/null; crontab -l | grep -E 'hf-convert|gvs5h|gguf-e2b'
   ```
   Expect nothing. If any active project config names these home paths (for example a Qwen launcher script), list it.
7. **Destination policy:** confirm the `/` reserve floor, and that `/home/steven/.cold-archive` does not exist yet (`stat` only).
8. **Then (not read-only, separately reviewed):** the r6 tool delta, followed by `plan` → `copy --bwlimit` → `verify` → root writer-check → `cutover` → a separately reviewed reclamation of `.retire-*` → `df` proof that `/vm` avail ≥ 385,899,345,920 B. Only after that is the qualification VM eligible, and the memory floor still applies.

## Not claimed
- That any subtree is cold. That needs checks 2, 3 and 5 to be clean.
- That Qwen does not use these models. That needs check 5's Qwen evidence.
- Any freed space before reclamation.
- `.pixel10` subtree suitability. Its inventory is incomplete and hardlink groups could span subtrees.
