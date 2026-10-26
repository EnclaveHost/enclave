# nvme-cold-relocation-stage/r6 (PREPARED by Claude; nothing run). r5 unchanged + a separate directory-destination subtree mode

- **`relocate.py`:** byte-identical to frozen r5 (`2a037dae…`). The USB ext4-image mode for whole `codex-archive`/`.pixel10` is unchanged, and its r5 suite (`tests/test_relocate.py`, 22) is re-run unchanged.
- **`subtree.py`** (new, 528 lines) is the new mode. It relocates EXACTLY `codex-archive/2026-10-24/home/{hf-convert,gvs5h,gguf-e2b}` to `/home/steven/.cold-archive/codex-archive/<same path>` on `/` (ext4, cryptroot).
  - It imports r5's reviewed primitives; `relocate.py`'s sha256 is pinned and checked at import.
  - It has its own small config (`config.subtree.production.template.json`; format `nvme-cold-subtree-config/v1`) and its own journal, refusing an r5 journal.
- **Phases:** `plan` → `inventory-source` → `copy` → `verify` → `emit-writer-check` / ROOT `writer-check` → `cutover`, with `rollback`.
  - `inventory-source` reuses 1381 hashes only on an exact, complete identity match, otherwise `--fresh-hash`.
  - `copy` and `verify` run inside root's queue lane only.
  - **There is NO deletion phase.**
- **Tests:** `tests/test_subtree.py` (15) and `jobs/tests.sh` (512 MiB, `unshare -Urn`, like r5).
- **Report:** `logs/claude-cold-subtree-r6.md`.
