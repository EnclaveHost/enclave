# Evidence index (actual root files; byte copies; sha256 of every source in `EVIDENCE-SHA256.txt` and `CONTROLS-SHA256.txt`)

| Path | Root job | Result |
|---|---|---|
| `root-a2-v2-bound-unit-2330.{out,rc,guard}` | first unit run | **FAILED 1** (test fixture replaced the bound A1 receipt; release correctly refused with `a1_binding`). Kept. |
| `unit-r2-2336/root-a2-v2-bound-unit-r2-2336.{out,rc,guard}` + `unit-r2-2336/run-r2/*` | repaired unit run (`A2_TEST_RUN=run-r2`) | **PASS:** Python 42 + 2 + 1, Node 8, 0 skipped; rc 0; `[queue] EXIT 0`; guard peak 107 MiB / min host 22334 MiB; inputs 31/31 |
| `mutants-2336/root-a2-v2-bound-mutants-2336.{out,rc,guard}` + `mutants-2336/20261025T233849Z-181101/*` (111 files) | 47 negative controls | **PASS:** `MUTANTS rc=0`; rc 0; `[queue] EXIT 0`; guard peak 141 MiB / min host 22216 MiB |
| `jobs/root-a2-v2-bound-validated-2336.sh`, `jobs/q-exit-status.sh` | root coordinator (pid 96417, finished 0) | Runs unit r2, then the mutants, each with its exit status recorded |

## Controls: parsed checks

These are from the copied files.

**Mutant results:**
- **Kill lines:** exactly 47 `mutant <name> killed` lines, with 47 unique names, equal to the `EXPECTED` set of the stage `mutants.sh` (33 inherited + 14 v2).
- **No failures:** no `MUTANT … NOT killed`/`survived`/`invalid` line.
- **Verdicts:** every one of the 47 `<name>.verdict.json` reads `killed`. Python verdicts show 0 errors, skipped, expected failures, unexpected successes or double runs. JS verdicts show 0 cancelled, skipped or todo, and no bad markers.

**Baselines:**
- `baseline-py.verdict.json`: `baseline-clean`, 42 tests, 0 errors, 0 skipped;
- the writer `Ran 2 … OK` and manifest `Ran 1 … OK` logs;
- `baseline-node.verdict.json`: `baseline-clean`, 8/8, 0 skipped or todo.

**Preflight and inputs:**
- `preflight.json` ok, 47 names, no bad anchors;
- `inputs.check` 31/31 OK, with the stage `SHA256SUMS` `402433176104631e9d386ec228eb1cc98a1596e27e84924179914eeaf20bc46f`.
