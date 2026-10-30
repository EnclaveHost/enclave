# Finality r6: test-only fixture repair (PREPARED; nothing run by Claude; frozen r6 unchanged and still verifying)
**Stage:** `base-finality-proof-stage/r6-test-fixes/`: fixed copies `tests/`, `patches/`, `jobs/root-finality-r6-fixes.sh`, `SHA256SUMS`. **No product code changed. No gate weakened.** Every changed expectation is now an *exact* code, checked against the actual r6 source.
Root's run: `r6/logs/root-finality-r6-tests-20261026T054735Z-964702`.

| Suite | Result |
|---|---|
| tool | 34 ran, 30 ok, **3 FAIL + 1 ERROR** |
| integration | **never ran** (import error) |
| sampler | **92 OK** |
| reanchor-recovery | **24 ran, 15 ERROR** |
| r3-regression | pending at writing |

## Fixed (tests only; confirmed against the r6 source)
| Test | Actual r6 behaviour (source) | Change |
|---|---|---|
| `Gates.test_no_proof_status_is_none_and_a_missing_a1_dir_refuses` | `finality_dir_of` (`src/finality_state.py:454-457`) refuses any directory other than `<launch>/finality`, a missing one included, **before** path checks | expects exactly `finality_dir` (was `path`) |
| `Gates.test_revoked_then_truncated_stays_terminal` | `anchored()` (`:463-472`): the launch journal still names the deleted entry 2, so the call refuses `finality_journal_rolled_back` before the terminal check | expects exactly `finality_journal_rolled_back`; `status` must now be `refused` with that exact prefix (stronger than "not qualified") |
| `Gates.test_status_survives_only_the_bootstrapped_event_naming_this_entry` | a `bootstrapped` event naming another entry fails `anchored()`, so `status` → `{'state':'refused', 'refused':'finality_journal_rolled_back: …'}` (`:556-562`) | asserts state `refused`, qualified False and the exact `finality_journal_rolled_back:` prefix; the other three stale cases are unchanged |
| `Gates.test_published_status_is_what_the_readiness_gate_requires` | `readiness_sampler.validate_finality_status` reads `a.max_finality_status_age` (`:330`); the CLI default is 900 (`:989`) | the fixture namespace gains `max_finality_status_age=900`; every assertion is unchanged |
| integration import (all 16) | `wrapper/chain_service.py:26` reads `/etc/enclave-rpc-vm/disks.json` at import; the boot stub intercepted only manifest/chain.json | the stub also answers `disks.json` with exactly r7's wrapper-suite stub (`{'disks':[{role,mount,uuid:'expected'}…]}`) |

**Pins:**
- r6 `tests/test_finality_state.py` is `78bf40d4…` → fixed `58d7a9e6…`; r6 `tests/test_finality_integration.py` is `595df4c4…` → fixed `d21f67fe…`.
- Patches: 19 and 4 changed lines.
- `r6-test-fixes/SHA256SUMS` sha256 is printed by the job; the job also requires the fixed copy to equal r6 + patch.

**Any future qualification must name these fixture hashes.** The original r6 manifest did **NOT** pass.

## Root command (queue 1024)
```
python3 -u ../claude-test-queue.py --mib 1024 --log base-finality-proof-stage/r6-test-fixes/logs/root-finality-r6-fixes.guard -- unshare -rn bash base-finality-proof-stage/r6-test-fixes/jobs/root-finality-r6-fixes.sh
```
- **Checks before running:** frozen r6 and the stage SHA256SUMS; both r6 test pins and both fixed pins; fixed == r6 + patch.
- **Executes** in a private copy of r6 (without logs) with only the two test files swapped:
  - **tool, 4 exact cases** (expect Ran 4, OK);
  - **integration, 16** (expect Ran 16, OK).
- **Reuse justification:** the other 30 tool cases are byte-identical in the fixed file (the patch touches only those 4 methods' bodies and the namespace line inside one of them) and run on the same product bytes. Root's `tool.txt` (sha256 `8f217ae6…`, 30 `ok`) is pinned. The sampler (92 OK) runs `readiness/test_readiness_sampler.py`, which is untouched.

## NOT fixed: reanchor-recovery, 15 errors with one common cause (an honest open item)
- **The cause:** all 15 errors are the same refusal: `binary_pin: the config names another base binary than the harness pin`, at `producer/base_launch.py:406`.
  - r6's new `bound_config()` (used by `arm`, `rearm` and restart permits) compares the test config's `baseBinarySha256` with the module constant `HARNESS_BINARY_SHA256` = production `9c44836d…`.
  - The ported r7 fixtures use a stand-in binary. They already pass `harness_binary_sha=self.cfg['baseBinarySha256']` to `produce`, but `arm` has no such parameter.
- **Proposed test-only fix, not made here:** in the ported `tests/r7-ported/test_reanchor_recovery.py` / `test_r3_launcher.py` fixture, bind the producer's pin to the fixture's stand-in binary for the test's duration. That is `patch.object(P, 'HARNESS_BINARY_SHA256', self.cfg['baseBinarySha256'])`, the same pattern as the existing `A.BYTECODE_CHECKER_V2_SHA256` stand-in. Add one test that the **unpatched** pin still refuses a stand-in config with exactly `binary_pin`.
- **Expect the same cause in r3-regression** if it calls `arm`. Not verified: its log was not complete when I read the run.
- These suites are therefore **not** in this job.
