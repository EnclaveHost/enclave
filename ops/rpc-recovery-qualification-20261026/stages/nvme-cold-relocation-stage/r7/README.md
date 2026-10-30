# nvme-cold-relocation-stage/r7 (PREPARED by Claude; nothing run). r6 + root 1523 review: the relief mode no longer reads the VM guard JSON

- **`relocate.py`:** byte-identical to frozen r5 (`2a037dae…`). The USB ext4-image mode for whole `codex-archive`/`.pixel10` is unchanged, and its r5 suite (`tests/test_relocate.py`, 22) is re-run unchanged.
- **`subtree.py`** (r7) is the new mode. It relocates EXACTLY `codex-archive/2026-10-24/home/{hf-convert,gvs5h,gguf-e2b}` to `/home/steven/.cold-archive/codex-archive/<same path>` on `/` (ext4, cryptroot).
  - It imports r5's reviewed primitives; `relocate.py`'s sha256 is pinned and checked at import.
  - It has its own small config (`config.subtree.production.template.json`; format `nvme-cold-subtree-config/v1`) and its own journal, refusing an r5 journal.
- **Phases:** `plan` → `inventory-source` → `copy` → `verify` → `emit-writer-check` / ROOT `writer-check` → `cutover`, with `rollback`.
  - `inventory-source` reuses 1381 hashes only on an exact, complete identity match, otherwise `--fresh-hash`.
  - `copy` and `verify` run inside root's queue lane only.
  - **There is NO deletion phase.**
- **Tests:** `tests/test_subtree.py` (19) and `jobs/tests.sh` (512 MiB, `unshare -Urn`, like r5).
- **Report:** `logs/claude-cold-subtree-r6.md`.

**r7 (root 1523 review):**
- **Guard JSON:** the stopped RPC VM's `guard-status.json` has `state: stopped`, a stale `free`, and NO thresholds, so r6's `guard_status` would refuse; its copy also refused a low `/vm`, which deadlocks relief. **r7 does not read it at all**; a `guard` key in the config is refused.
- **`/vm` free:** reported from `statvfs`, informational only.
- **Writes:** before any journal or destination write, r7 proves the destination tree and the journal are on the pinned `/` filesystem (mountinfo device + `st_dev` ≠ the source's).
- **Capacity:** copy needs all three subtrees inventoried, and `/` must stay ≥ 300 GB after EVERY remaining copy.
- **Bandwidth:** `bwlimit_kib` ≤ 204800 (200 MiB/s).
- **Unchanged:** the production VM's prepare/controller/guard thresholds, which this mode does not touch.
- **Tests:** 19.
