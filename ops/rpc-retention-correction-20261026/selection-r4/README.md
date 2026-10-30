# base-retention-stage/selection-r4 (PREPARED by Claude; nothing run). Source only. activation-r2 (live), selection-r3 and the guest stay unchanged

**Why:** root 1404 / `logs/claude-retention-state-redownload.md`.
- reth plans `state` (and headers) as All whenever the manifest declares it.
- It reuses an archive only on exact size + blake3, and deletes the outputs of every pending archive before fetching it (`cleanup_outputs`).
- `finalize` rewrites the DB. So a second run over a finalized datadir deleted the MDBX and re-downloads 761 GB.
- r3's size-presence cache could not prevent that. The earlier "only --force/--prune-unlisted delete" docs were FALSE.

**Files:**
- `retention_preflight.py`:
  - Keeps r3's boundary formula, and the tests compare it with frozen r3.
  - REFUSES any manifest but the pinned `1f0c4e6c`. A state-less or derived manifest needs separately reviewed provenance (exact same block, checkpoint and readiness review), which is not implemented.
  - REFUSES when the manifest declares state and ANY state output, `db/*` entry or state download cache exists. Same size is not integrity; reth would delete it.
  - Counts mandatory state, all 107 headers and the 30 history archives.
  - Reports `cliWouldPlanPending`, which reproduces the live 23, and the bound if every present output failed integrity.
  - Emits the command only when admitted, scoped to the datadir as checked.
- `verify_retention_completion.py`: READ-ONLY. `jobComplete` needs all four of:
  - `terminal`: the exact InvocationID, inactive, success, status 0, reviewed argv. A failed or other invocation is never complete.
  - `marker`: the r2 marker is exact, root 0444, and completed after the invocation started. It is labelled a 26-subset record.
  - `history`: size presence of the 30 archives plus 107 headers, with at-or-above-floor separate from below-floor.
  - `state`: `db/mdbx.dat` is present. The original sizes and blake3 are NOT required after finalize.
  - Size presence is NOT integrity or readiness, and coverage is claimed from the declared floor only.
- `test_selection_r4.py`: 13 offline tests. `jobs/root-selection-r4-tests.sh` is the root 256 MiB lane, NOT run.
