# standalone-mcp-authority-stage/r7: CONTINUATION runner only (PREPARED; nothing run by Claude)

**Product unchanged:** the same b6ac5d657 base, the r2 patch, `CANDIDATE.sha256` and `EXPECTED-TAP.txt` (8 rows, 73 tests). r6, its ended run `r6/run/20261026T035555Z`, r5 and r2 are FROZEN.

## Root's actual r6 run (`logs/root-mcp-authority-r6-0333.out`, exit 20 SETUP; cap 2560 MiB, peak 931 MiB from git clone)
- **Passed before the failure:**
  - two independent offline builds of the complete 12-artifact closure;
  - comparator unit tests **23/23**;
  - semantic **EQUAL `426a71358fd9773b4d599afe550e07efb7c8e817b00ca2b496b1df4589a1f0ac`** (raw `12f18270…` / `f3c54c9b…`).
- **Then:** `[FAIL] the artifact build changed tracked files`.
- **Why that message is false:**
  - Base `git status --porcelain` holds only `?? node_modules`, the read-only symlink to `relay-consumer-source/node_modules` that the runner itself creates after its earlier clean check.
  - The candidate holds exactly ` M` for the 3 patched files, `??` for the new test, and `?? node_modules`.
  - No tracked file changed. This is a runner setup defect, not a product defect.

## r7 (`jobs/standalone-mcp-authority-r7-continuation.sh`)
- **Reuses r6's qualified evidence. Nothing is cloned, built or compared again.**
  - `R6-RUN-RECEIPT.sha256` pins 28 files of the ended r6 run: comparison JSON, inputs, raw and cache manifests, `comparator-unit.tap`, `comparator.out`, and 20 forge logs.
  - `R6-ROOT-LOG.sha256` pins root's log and rc. The runner also requires the exact 23/23 and EQUAL lines.
- **EXACT expected state, not a blanket untracked ignore:** `EXPECTED-STATUS-{base,cand}.txt` is compared byte-for-byte. The runner also checks:
  - HEAD, BASE/CANDIDATE pins, and that the r2 patch reverse-applies;
  - the `node_modules` symlink target and the lock + noble pins (`DEPS-PINS.txt`);
  - r6 `SOURCE-PINS.sha256`;
  - raw artifact and cache manifests recomputed equal to r6's.
- **Private copies:** `cp -a --reflink=auto` copies under `r7/run/`. The copies are re-checked identically; the r6 run stays untouched and is re-verified at the end.
- **Tests:** ONLY the 8 rows / 73 tests, with exact counts, 0 skip/cancel/todo, and rc 0 for every row.
- **After the tests:** the exact status is unchanged and the artifacts are unchanged. Ignored-entry deltas are recorded in `IGNORED-DELTA-*.txt`, and any ignored change under `contracts/foundry` fails the run.
- **Runtime forge:** the rigs' `lease-gas-forge.mjs` build runs into the private `TMPDIR`. The runner requires the pinned forge on PATH.
- **Cost:** about 1.3 GB of copies (r6 base and cand are 665 MB each).

**The full MCP surface is NOT qualified until root's r7 run reports 73/73 PASS.**
