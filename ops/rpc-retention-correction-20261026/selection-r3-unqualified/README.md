# base-retention-stage/selection-r3 (PREPARED by Claude; nothing run). Source only; activation-r2 and the live install are untouched

**Finding** (`logs/claude-retention-selection-audit.md`): pinned reth 7134be3 selects `--with-*-since B` chunks from
`(total_blocks - min(snapshot - B + 1, total_blocks)) // blocks_per_file`. The pinned manifest has total_blocks == block == 53048526,
so 48000000 / 52500000 also select chunks 95 / 104: **30** archives. activation-r2 (live) counts **26**.

- `cached_download_preflight.py`: the r3 preflight, with the exact formula and full manifest validation.
  - **Reports** (all computed from the manifest; no totals are hardcoded):
    - `required` (30);
    - `missing` (22 in the worst case after the first batch);
    - `belowDeclaredFloor` (4 archives, compressed and extracted bytes, and which are missing);
    - `cliAlsoPlanned` (headers 107 + state 1, which the CLI reuses when they verify; any that are absent count as missing);
    - the unchanged reserves (index ESTIMATE, max(2×, 150 GB); 30-day growth);
    - the same command as the live unit's ExecStart.
  - `declaredFloor` stays 48000000 / 52500000, and `readiness` says NOT readiness. Coverage is never claimed from a below-floor chunk.
- `verify_full_selection.py`: READ-ONLY evidence for the full 30-archive selection (path + exact size), after the live unit exits.
  - It refuses while the unit runs.
  - It reports the live r2 `retention-complete` marker as a 26-archive subset, never as completion.
  - It writes nothing.
- `test_selection_r3.py`: 15 offline tests covering:
  - boundary, non-boundary, edges, zero/future/non-integer starts, and 13 invalid-manifest mutations;
  - the REAL pinned manifest with sparse outputs: 30 archives; the 4 below-floor archives; 22 missing; reserves; header/state reuse; command equal to the live ExecStart; the r2 files unchanged;
  - the verifier: refuses while running; the r2 subset plus its marker is not complete; full 30 is complete; a wrong size is partial; it is read-only.
- `jobs/root-selection-r3-tests.sh`: the root offline lane. `jobs/guest-full-selection-evidence.sh`: the guest read-only evidence, after the unit exits.
