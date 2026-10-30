# Cold subtree relocation r6: nvme-cold-relocation-stage/r6 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I ran no tests, hashes, copies, mounts, network, live actions or commits.
- **Checks I made:** `ast` parse (3.12 grammar), `bash -n`, `json` parse of the template, `sha256sum -c`.
- **Frozen and unchanged:** the original stage, r2, r3, r4 and r5. Sums re-verified; the r6 job re-checks every one.
- **One disclosure:** while preparing, I ran one read-only `json.load` of the live archive manifest (`…/recovery-documents/artifact-relocation-manifest.json`) to confirm it parses. Nothing was printed or written. No other live archive file was read.
- **Not touched:** Qwen, Projects, `.pixel10` and the VMs.

## Stage
`nvme-cold-relocation-stage/r6/`, `SHA256SUMS` = **`b50c3c88d698637169498abdc58bbb9e7e000ee70810ee4f10c7d9bd631df27b`** (read-only)

| file | sha256 | note |
|---|---|---|
| `relocate.py` | `2a037dae4bb38df19979b0f7397d44da2d7219f1a55cc455f1e35b8ecb49e3d0` | **byte-identical to r5**: the USB ext4-image mode is unchanged |
| `subtree.py` | `658a05d31669a1a2167e9c1524949c18784755b241e708d50d68f9b7431d8e29` | new directory-destination mode (528 lines) |
| `tests/test_relocate.py` | `dc597306da188b97f341c016f0b3f20f6f611be157aa0dbcc3e9001bd9c7d051` | r5's suite, unchanged (22) |
| `tests/test_subtree.py` | `59afe1ec4f13ecb12ee2043921a9e7133a913b28327b49c0c60b68ec586929f4` | 15 |
| `jobs/tests.sh` | `9e282039820a96be4c88979af455f1124979654dd9f45a1e541d963e67f44687` | |
| `config.subtree.production.template.json` | `c9dcb5c0f99139bb509c894c2065afa785b2e723123529dfe511f67a78e8380f` | |
| `README.md` | `d67dd988e001b2f84c4c50501221c8e3dc7320391e19023e170aba7dd68f14c7` | |

## Why a separate module, not a schema change to relocate.py
- r5's config, journal and phases are built around the two whole trees and the image: `prepare-image`, mount/persistence handoffs, the USB busy check.
- Adding a directory mode inside it would touch every phase and change the reviewed bytes.
- So `subtree.py` imports r5's reviewed primitives. It refuses to load unless `relocate.py` is the exact r5 sha256. The primitives it uses:
  - `walk_meta`, `hash_files`, `logical`, `digest`, `inventory`, `identity_now`;
  - `scan_proc`, `restore_dir_mtimes`, `safe_rsync_argv`, `Journal`;
  - `check_mount`, `guard_status`, `required_bytes`, `require_attestation`, `_our_symlink`.
- It adds a small config of its own (format `nvme-cold-subtree-config/v1`) and its own journal. It refuses to use an r5 image journal or root's 1381 journal as its journal.

## Pins (production; `load_config` refuses any deviation)
**Paths and mounts:**
- **Subtrees:** exactly `2026-10-24/home/hf-convert`, `2026-10-24/home/gvs5h` and `2026-10-24/home/gguf-e2b` under `/vm/enclave-volumes/codex-archive`. No others; no nesting.
- **Source mount:** `/vm`, ext4, `/dev/mapper/cryptvm`.
- **Destination mount:** `/`, ext4, `/dev/mapper/cryptroot`. Both are checked against `/proc/self/mountinfo` at every phase. ext4 only: ntfs3/USB is refused in this mode.
- **`dest_root`:** `/home/steven/.cold-archive/codex-archive`.
  - **Privacy:** `.cold-archive`, `codex-archive`, `2026-10-24` and `home` must each be **0700**, owned by uid 1000, with no symlink anywhere on the path. They are created 0700 only at the first copy.
  - **Metadata:** each subtree keeps its own modes, owners, nanosecond mtimes and xattrs (`rsync -aHAX --numeric-ids --one-file-system`, then r5's directory-mtime restore).

**Other pins:**
- **Manifest:** `…/artifact-relocation-manifest.json` with sha256 `77b5cf1c…` and 2102 entries; only the entries inside each subtree are used.
- **1381 inventory:** identity `d3f4775f…`, logical `fb369205…` (root 1381's output).
- **Guard:** shutdown 468,719,476,736 / floor 300,000,000,000, unchanged.
- **`dest_floor_bytes` ≥ 300,000,000,000:** `/` keeps its 300 GB operational floor **after** every remaining copy.

## Behaviour
**`plan`** (read-only):
- pinned mounts;
- the archive root is the owner's 0700 directory;
- the private destination (where it exists);
- the guard;
- each subtree is a real directory with no `.retire-*`, and its manifest links resolve into `/vm`;
- capacity: `/` avail − remaining inventoried need ≥ floor;
- notes: no deletion, and the Qwen caveat (below).

**`inventory-source --subtree S`:**
- A metadata walk of `S`.
- **1381 hash reuse only when all of these hold:**
  1. the 1381 journal's `state.json` identity/logical equal the pins;
  2. a **recomputed** digest of its `meta.json` equals the identity, and of its `logical.json` equals the logical (a tampered journal refuses);
  3. the path set under `S` is exactly the same;
  4. every record is identical: type, mode, uid, gid, xattrs, size, mtime, nlink, link target, and (dev, inode, ctime). The subtree's own top compares dev+inode, since r5's `walk_meta` zeroes a root's ctime;
  5. no hardlinks.
- Any mismatch refuses ("no reuse"). `--fresh-hash` re-hashes that subtree fully, inside the queue lane. There is **no** partial or stale reuse.
- A second walk must equal the first.

**`copy --subtree S`:**
- **Refuses unless:**
  - it runs inside **root's queue lane**: its own cgroup `memory.max` must equal `queue_lane_bytes`. The queue's `memory-guard.mjs` polls host MemAvailable every 250 ms and SIGTERMs the whole job tree, rsync included, below 16 GiB. That is the continuous floor;
  - MemAvailable ≥ 16 GiB at start;
  - the `/vm` guard is above shutdown;
  - the source identity is unchanged since inventory;
  - `/` avail − need ≥ `dest_floor_bytes`;
  - no foreign destination exists.
- **Then** rsync with the operator's `--bwlimit`. r5's `safe_rsync_argv` refuses `--del*`, `--remove-source-files`, `--inplace` and `--append*`.
- **Resumable;** nothing is deleted.

**`verify --subtree S`:**
- in the queue lane;
- the source identity must still be the inventoried one, so its hashes are exact;
- a **fresh** sha256 of the destination (r5's `inventory`);
- logical source == destination, which includes mode, owner, mtime, size, xattrs and sha256;
- every manifest entry's sha256/bytes match the destination.

**`emit-writer-check` → `sudo bash writer-check.sh` → `writer-check` (root):**
- the script pins the sha256 of both `subtree.py` and `relocate.py`;
- r5's complete `/proc` scan (fd, cwd, root, exe, maps, threads, loop backing, swap) over all three subtrees, their real paths, `.retire-*` and destinations;
- incomplete visibility counts as a failure.
- **This is the one concrete, separate local sudo step.**

**`cutover --subtree S --apps-stopped-attestation "…"`:**
- **Refuses unless:** verified; a fresh (≤ `writer_check_max_age_seconds`), complete, zero-hit writer-check that covers `S`; source and destination identities unchanged since verify; pinned mounts; private destination.
- **Then:** rename `S` to `.retire-<name>` in the same directory, symlink `S` → destination, post-checks (readlink/realpath; top mode equal; every manifest link of `S` now resolves into the destination).
- **Any failure rolls back automatically.** Crash recovery is r5's `renaming`/`renamed` logic.

**`rollback --subtree S`:**
- unlinks only OUR readlink-verified symlink and renames `.retire-<name>` back;
- refuses if the destination changed since cut-over (writes through the symlink).

**No deletion phase:**
- **`/vm` is freed only by a SEPARATELY reviewed reclamation** of the three `.retire-*` trees, with exact verified identity.
- The tests assert the only unlink in a full flow is our own symlink.

## Capacity (recorded explicitly)
- **Space freed after reclamation:** the three subtrees free **327,903,137,792 B**, about 328 GB, allocated (audit `du`).
- **Effect on `/vm`:** it rises from 79,900,258,304 to about 407.8 GB. The qualification threshold is 385,899,345,920, so the margin is **≈ 21.9 GB**.
- **The live Qwen padbank (485 GB, not touched) can still grow by about 64 GB. If it resumes, that margin, and with it qualification capacity, is lost.** `plan` prints this note.
- **`/`:** about 770 GiB (≈ 826.8 GB) free, about 498.9 GB after the copies. The tool refuses below 300 GB. Root must confirm the `/` floor and other consumers.
- **Nothing is freed** by copy, verify or cutover.

## Tests (15 new + 22 r5 unchanged; not run)
1. **Pins:** `relocate.py` equals r5. The production config loads, and every deviation refuses: archive, subtrees ±1, destination, floor 299,999,999,999, an ntfs3 destination, guard, 1381 identity, the journal equal to 1381's.
2. **Inventory:** the exact 1381 identity gives reuse (hashed 0), and its logical equals a fresh hash. An mtime change, an added file or a chmod each refuse reuse. `--fresh-hash` outside the queue refuses, inside it works. A tampered 1381 `logical.json` is never trusted.
3. **Copy refusals create nothing:** not inventoried, lane, MemAvailable below 16 GiB, guard at shutdown, capacity below the floor, wrong mounts, source changed after inventory.
4. **Destination:** a 0755 `.cold-archive` refuses; a symlinked one refuses.
5. **Copy + verify:** 0700 parents; modes, mtimes and sizes exact; a same-size, same-mtime content tamper of the destination is detected.
6. **Writer-check gates:** non-root; the script pins both shas; missing, incomplete, hits, stale, wrong prefix; no attestation.
7. **Cutover:** the original path is a symlink to the destination; `.retire-hf-convert` is kept; the home manifest link resolves into the destination; a sibling (`home/Projects`) is unchanged; rollback restores and keeps the destination.
8. **Source changed after verify** refuses. **A manifest link broken before cutover** makes the post-check fail, with an automatic rollback: source restored, no `.retire`.
9. **Rollback after writes through the symlink** refuses.
10. **Safety:** behaviourally, no `unlink`/`rmdir`/`remove`/`rmtree` except our own symlink; every rsync argv is bounded (`--bwlimit`) and non-destructive. An r5 image journal is refused. `plan` reports capacity and the padbank caveat, and refuses when `/` would fall below the floor.

**Root command (offline, temp fixtures):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cold-r6 512 unshare -Urn bash nvme-cold-relocation-stage/r6/jobs/tests.sh
```
PASS = `test_relocate` 22 OK + `test_subtree` 15 OK, nothing skipped, the original stage and r2-r5 frozen, r6 sums intact.

## Live sequence (root; after the PASS and root's read-only checks in `logs/claude-capacity-nextstep-1510.md`)
1. **Config:** fill the template's three REQUIRED values (`bwlimit_kib`, `queue_lane_bytes` = the exact `memory.max` of the lane you will use, `writer_check_max_age_seconds`). **Verify** `inventory_1381.journal_dir` is the directory 1381 actually wrote; the template has r5's `/home/steven/.local/state/nvme-cold-relocation`. Save as a 0600 owner file.
2. **Plan:** `python3 -I r6/subtree.py plan --config CFG`.
3. **Per subtree**, from root's queue lane: `inventory-source`, then `copy`, then `verify`.
4. **Writer-check:** `python3 -I r6/subtree.py emit-writer-check --config CFG`, then the concrete local `sudo bash ~/.local/state/nvme-cold-subtree-r6/writer-check.sh`.
5. **Cutover:** `cutover --subtree S --apps-stopped-attestation "<what was stopped>"`, per subtree, within the writer-check age.
6. **Reclamation of `.retire-*`:** a separate review. Then the `df` proof that `/vm` avail ≥ 385,899,345,920 B.

## Unresolved / not claimed
- That the subtrees are cold: root's 1510 checks 2, 3 and 5, and the Qwen maps.
- That 1381's journal still sits at the template path.
- The real `/proc/self/mountinfo` sources (`/dev/mapper/cryptvm`, `/dev/mapper/cryptroot`). The `/` mount source string must match exactly, or `plan` refuses.
- Rsync timing at the chosen `--bwlimit`.
- Any freed space before reclamation.
