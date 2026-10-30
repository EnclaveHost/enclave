# nvme-cold-reclaim-stage/r3 (PREPARED by Claude; nothing run). r2 + the FROZEN r9 API; report `logs/claude-cold-reclaim-r3.md`

- **Scope:** exactly the three `/vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-*` originals, each only after its r9 cut-over is `complete`. Owner-only, never root. Inside the queue lane with the 16 GiB floor; `/` ≥ 300 GB. No recursive rm, no wildcards, nothing outside the plan.
- **r9, frozen** (`SHA256SUMS` `cc4d7cd3…`), is reused in place by sha-pinned compile + exec: `subtree.py` `ba716ac4…`, `relocate.py` `2a037dae…`, job `316f4e8e…`.
  - **Used from r9:** bounded no-follow reads, config/journal/path helpers, `WC_FORMAT`, the 18 `WC_KEYS`, and the 3-key `tool_shas()`.
  - **Accepted:** only r9 root scans, as stdout of the r9 README's staged wrapper, redirected by the owner.
- **Blocks this subtree** (writes through a missed holder of a retired inode are lost when its last fd closes):
  - incomplete or truncated scans;
  - any hit on this subtree's retired/destination inodes, or a path-only hit under its src/`.retire`/destination (including ` (deleted)`);
  - any alias or destAlias of it;
  - any `fsWatchers`.

  Other subtrees' users do not block it.
- **Phases:**
  1. **`verify`** (fresh full destination hash, bound receipt).
  2. **Root:** scan A.
  3. **`reclaim --result A --reclaim-retired <exact>`:**
     - inner entries: rename to `.reclaim-r3-<i>` → O_PATH re-check → unlink/rmdir;
     - **the top keeps its `.retire-<name>` name** until `rmdir`, so a deleted inode's `/proc` path stays under r9's prefix (A7);
     - the phase ends in `deleted-unconfirmed`.
  4. **Root:** scan B.
  5. **`confirm --result B`:** `.retire` absent (ENOENT, here and in the scan), zero users/aliases/watchers, destination unchanged, and a **fresh full re-hash of the retained copy** == the receipt → `complete`; otherwise `post-check-failed`.
  6. **`check-retained`.**
- **Tests:** `tests/test_reclaim.py` (11) uses the REAL r9 phases and the real r9 scanner over owned fixture `/proc` trees and one owned child process; `jobs/tests.sh` runs it under `unshare -Urn`.
