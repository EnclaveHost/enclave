# nvme-cold-reclaim-stage/r4 (PREPARED by Claude; nothing run): reclaim r3 adapted to the FROZEN r10 scanner API. Report: `logs/claude-cold-reclaim-r4.md`

**Scope:** exactly the three `/vm/enclave-volumes/codex-archive/2026-10-24/home/.retire-*` originals, each only after its r10 cut-over is `complete`.
- Owner-only, never root.
- Inside the queue lane with the 16 GiB floor; `/` ≥ 300 GB.
- No recursive rm, no wildcards, nothing outside the plan.

**Frozen r10** (`SHA256SUMS` `2342e677…`) is reused in place by sha-pinned compile + exec:
- **Pins:** `subtree.py` `90cd8968…`, `relocate.py` `2a037dae…`, job `7bcd4fbf…`.
- **The tool refuses to load** unless r10's `WC_FORMAT` (`nvme-cold-subtree-writer-check/r10`), the 18 `WC_KEYS` and the 3 `TOOLS` equal the pinned ones.
- **Accepted:** only r10 root scans (the r10 README staged wrapper, redirected by the owner). The r8 and r9 formats are refused.

**Changes vs r3 (API integration only):**
- the pins, format and loader (r10);
- every scan target is bound by its **top `(dev, ino)`** (r10 `ino`) plus `majmin` and `entries`:
  - the retired top = the plan's first record;
  - the destination top = the receipt's new `dest_top`;
- the config, journal, receipt and temp-name namespace are `r4` (`~/.local/state/nvme-cold-reclaim-r4`, `.reclaim-r4-<i>`).

**Unchanged from r3:**
- every block: incomplete or truncated scans; any hit on this subtree's retired/destination inodes, or a path-only hit under its paths (including ` (deleted)`); any alias or destAlias; any `fsWatchers`;
- the never-renamed `.retire` top (A7), the fd-anchored per-entry deletion, and scan B;
- `confirm` = a fresh full re-hash of the retained copy.

**Phases:**
1. `verify`
2. root: scan A
3. `reclaim --result A --reclaim-retired <exact>` (ends in `deleted-unconfirmed`)
4. root: scan B
5. `confirm --result B` → `complete`, else `post-check-failed`
6. `check-retained`

**Tests:** `tests/test_reclaim.py` (11) drives the REAL r10 phases and the real r10 scanner over owned fixture `/proc` trees and one owned child process. `jobs/tests.sh` runs it under `unshare -Urn`.
