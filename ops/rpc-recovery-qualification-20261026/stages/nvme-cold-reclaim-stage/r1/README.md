# nvme-cold-reclaim-stage/r1 (PREPARED by Claude; nothing run): one-time reclamation of the three r8 `.retire-*` trees

- **Scope:** EXACTLY `/vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-{hf-convert,gvs5h,gguf-e2b}`, each only after its frozen-r8 cut-over is `complete`. Nothing else is touched: not the destination, the manifest, the home links, other archive trees, the production VM or its capacity thresholds.
- **Code:** `reclaim.py` runs as the owner, never root.
  - It reuses frozen r8 in place by sha256-pinned compile + exec (`subtree.py` `4509e043…`, which loads `relocate.py` `2a037dae…` the same way).
  - It only reads and flocks the r8 journal (`~/.local/state/nvme-cold-subtree-r7`) and has its own 0700 journal on `/` (`~/.local/state/nvme-cold-reclaim-r1`).
- **Phases:** `status`; `verify`, `reclaim` and `check-retained` run inside root's queue lane only (exact `memory.max`, MemAvailable ≥ 16 GiB, the queue's memory guard), with `/` ≥ 300 GB.
  1. **`verify --subtree S`:**
     - **r8 state:** the r8 cut-over is complete and consistent, and the original path is r8's symlink to the destination.
     - **Mounts:** pinned mounts; the source filesystem is mounted exactly once; no mount inside the original path, the retired tree or the destination; devices are right.
     - **Retired tree:** it is the tree r8 verified (identity including every child's ctime; the top's rename ctime is excluded).
     - **Destination:** unchanged since cut-over, and **every byte re-hashed now** (new cache, nothing reused) equal to the verified inventory and the manifest. Manifest links resolve into the destination.
     - **Plan:** only owner-owned regular files with nlink 1, and directories.
     - **Receipt:** `verify-<name>.json` (the exact plan) and `dest-<name>-<run>.logical.json` (per-file sha256 of the retained copy).
  2. **ROOT, read-only:** `sudo bash nvme-cold-relocation-stage/r8/jobs/root-writer-check.sh CONFIG8 > SCAN.json`. This is r8's frozen stdout scanner, unchanged; the owner's shell creates `SCAN.json`.
  3. **`reclaim --subtree S --result SCAN.json --reclaim-retired <exact .retire path>`:**
     - **The scan:** complete, r8 tool shas, taken after the receipt, ≤ `writer_check_max_age_seconds`, single-use. A user inside this retired tree blocks this tree only.
     - **Before anything goes:** the retired tree must still equal the plan.
     - **Deletion:** a validation pass, then per entry through directory fds (`O_NOFOLLOW`; dev/ino/ctime/size/mtime/mode/owner/nlink): `unlink` planned files, `rmdir` planned directories, the top last.
     - **Never deleted:** unrecognized or changed entries. They refuse.
     - **Crash-safe:** states `deleting` → `rmdir-top` → `complete`, and every unlink and rmdir is journalled. A re-run with a fresh scan resumes.
     - **Receipt:** `reclaimed-<name>.json`.
  4. **`check-retained --subtree S`:** after reclaim, re-hashes the retained destination in full against the receipt.
- **Recovery:**
  - Until `reclaim` starts, r8 `rollback` restores the original and keeps the destination.
  - After reclaim, the destination is the copy. `check-retained` proves it against the receipt. Moving it back to `/vm` would be a separately reviewed reverse copy; r8 rollback then fails closed ("missing: manual review").
- **Tests:** `tests/test_reclaim.py` (10), `jobs/tests.sh` (512 MiB, `unshare -Urn`).
- **Report:** `logs/claude-cold-reclaim-r1.md`.
