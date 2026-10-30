# nvme-cold-relocation-stage/r8 (PREPARED by Claude; nothing run). r7 + the r7 review: C1-C4 resume/recovery, W1-W3 root writer-check boundary

- **`relocate.py`:** byte-identical to frozen r5 (`2a037dae…`). The USB ext4-image mode for whole `codex-archive`/`.pixel10` is unchanged, and its r5 suite (`tests/test_relocate.py`, 22) is re-run unchanged.
- **`subtree.py`** (r8) is the new mode. It relocates EXACTLY `codex-archive/2026-10-24/home/{hf-convert,gvs5h,gguf-e2b}` to `/home/steven/.cold-archive/codex-archive/<same path>` on `/` (ext4, cryptroot).
  - It uses r5's reviewed primitives; `relocate.py`'s sha256 is pinned, and r8 compiles + execs exactly those verified bytes (never a `__pycache__` pyc).
  - It has its own small config (`config.subtree.production.template.json`; format `nvme-cold-subtree-config/v1`) and its own journal, refusing an r5 journal.
  - The template is byte-identical to r7, journal `…/nvme-cold-subtree-r7` included: r8 continues an r6/r7 journal (mode `subtree-r6`).
- **Phases:** `plan` → `inventory-source` → `copy` → `verify` → ROOT `writer-check` (via `jobs/root-writer-check.sh`, JSON on stdout) → `record-writer-check --result FILE` → `cutover`, with `rollback`.
  - `inventory-source` reuses 1381 hashes only on an exact, complete identity match, otherwise `--fresh-hash`.
  - `copy` and `verify` run inside root's queue lane only.
  - **There is NO deletion phase.**
- **Tests:** `tests/test_subtree.py` (27) and `jobs/tests.sh` (512 MiB, `unshare -Urn`, like r5).
- **Reports:** `logs/claude-cold-subtree-r6.md`, `-r7.md`, `-r8.md`.

**r7 (root 1523 review):**
- **Guard JSON:** the stopped RPC VM's `guard-status.json` has `state: stopped`, a stale `free`, and NO thresholds, so r6's `guard_status` would refuse; its copy also refused a low `/vm`, which deadlocks relief. **r7 does not read it at all**; a `guard` key in the config is refused.
- **`/vm` free:** reported from `statvfs`, informational only.
- **Writes:** before any journal or destination write, r7 proves the destination tree and the journal are on the pinned `/` filesystem (mountinfo device + `st_dev` ≠ the source's).
- **Capacity:** copy needs all three subtrees inventoried, and `/` must stay ≥ 300 GB after EVERY remaining copy.
- **Bandwidth:** `bwlimit_kib` ≤ 204800 (200 MiB/s).
- **Unchanged:** the production VM's prepare/controller/guard thresholds, which this mode does not touch.
- **Tests:** 19.

**r8 (r7 review):**
- **C1:** every `copy` attempt, a resume included, refuses unless `/` avail − the FULL remaining need (every inventoried subtree not yet `done`) ≥ the floor. Nothing runs on refusal.
- **C2:** a failed `verify` (logical or manifest mismatch) marks the copy `failed` with `checksum`; the next `copy` runs `rsync --checksum`.
- **C3:** re-inventory keeps this journal's own destination (`failed` + `checksum`). A destination is reused only if the journal's copy state is running/failed AND its top dev/inode equals the recorded `dest_top` (`copy` creates that 0700 top itself and records it before rsync runs; r6/r7 journals without `dest_top` are accepted). An unknown pre-existing directory is never adopted.
- **C4:** the rsync stderr tail (4 KiB) is kept in the journal event.
- **W1:** root runs `writer-check` only. It opens no journal, takes no lock, writes and chowns nothing, and prints the JSON to stdout. The owner's redirect creates the result file; `record-writer-check` validates it (exact keys, format, euid 0, both tool sha256 = these files) into the journal.
- **W2:** `relocate.py` is loaded by compile + exec of its sha-verified bytes. Root runs root-owned 0400 copies in a fresh `/run` dir with `python3 -I -B`.
- **W3:** `jobs/root-writer-check.sh` is frozen in SHA256SUMS with both shas as constants; `emit-writer-check` is removed.
- **Unchanged:** no `/vm` writes before cut-over, the 300 GB `/` floor, the 16 GiB memory floor and exact lane, the mount/path/link/hash pins, ≤ 200 MiB/s, no deletion.
