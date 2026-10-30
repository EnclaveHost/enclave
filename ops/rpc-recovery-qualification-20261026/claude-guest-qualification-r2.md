# guest-state-qualification-stage/r2: Q2 false-PASS fixes (source only)

**Status: PREPARED, NOT RUN.**
- **No tests or qualification are claimed.**
- No live, VM, network, build, tool or queue actions. The only checks were `py_compile` (host 3.14) and `bash -n`.
- **One process-hygiene note:** a stray `cat >` line in one of my shell commands blocked on stdin. I stopped that local shell myself. The only side effect was an empty `jobs-placeholder` file in the r2 draft, which I removed before freezing.
- r1 (`39be4e62…`) is unchanged and re-verified.
- **Not edited:** Claude370's `rpc-qualification-vm-stage` (plan not yet written) and `guest-state-install-stage`.

**Stage:** `guest-state-qualification-stage/r2/`, **SHA256SUMS sha256 `e828ae6aa8aa239284fdb71a8e07551b64d9b884372ddc188893eeb31ecaf551`** (8 files).

## Fixes (each of root's findings)
1. **Ignored rcs:** `systemd-analyze verify` rc ≠ 0, and `base --version` rc ≠ 0 or empty output, now **refuse** (rc 2) before any scratch side effect.
2. **Fixture map:**
   - An empty or malformed map refuses.
   - It must be **exactly** 11 entries (positive control + 10 hostile families, the new family being `setuid-bits`), each with its exact expectation, plus exactly 4 `goodOutputs`.
   - Each fixture's members are read in memory and must equal the map.
3. **No qualification without proof the binary ran.** Only transient-unit evidence counts: systemd-run's `Finished with result` + `Main processes terminated with: code=exited/status=N`, **and** reth's `Extracting local archive` line.
   - Timeout, launch/setup failure (no summary, or status 200–245), a signal or `RuntimeMaxSec` kill, an unparsable status, and a missing marker are **never** PASS.
   - A genuine refusal is an exit of 1–199 with the marker, result `exit-code`.
4. **Owned-unit stop:**
   - each case uses a fresh unique transient unit, verified absent before launch (never adopted);
   - before inspection or the next case it must be inactive/failed with `MainPID` 0, or unloaded;
   - otherwise ONLY that unit is stopped and re-verified;
   - if it cannot be verified stopped, the run **aborts** (rc 3), with no further cases and no inspection or cleanup.
5. **README correction:** Q2 runs the **pinned base binary directly**; the `guest_state.py` helper inside its real unit is **Q2b**, separate. The sandbox is still identical except for the reviewed `ExecStart`/`ReadWritePaths` substitution and the one `RuntimeMaxSec` bound. `--quiet` and `--collect` were dropped so the run evidence is kept.
6. **Logic tests:** `test/test_q2_logic.py`, **19 tests, mocked systemd/base/zstd/sha256, labelled NOT native qualification**. They cover:
   - the timeout, unlaunched, setup-status, no-marker and signal paths (none can PASS);
   - genuine refusal, confined and neutralized outcomes;
   - escape and unstopped-unit failures;
   - status parsing;
   - 9 malformed or empty fixture maps;
   - the precondition refusals (analyze/version), with the decoy mismatch and member mismatch refused before side effects;
   - owned-unit stop and abort reporting;
   - sandbox refusal.
   - Root job: `jobs/root-q2-logic-tests.sh` (exactly 19, bare `OK`).

## Unrun and unproven
- Every test and every guest script is unrun.
- The systemd-run summary and journal formats on noble (systemd 255) come from source knowledge. Unanticipated formats are classified unclassified/setup and **fail**, never pass.
- Guest Python 3.12 compatibility is by construction only.
- Q2b and Q4 are not covered.

## Root inputs
- the frozen candidate unit path and sha256, and the drop-in sha256;
- the `fixtures.json` sha256 and the run name (under `/srv/enclave-base-holder/tmp/gsq-r2/`);
- the candidate files installed at the unit's referenced paths, so the `systemd-analyze verify` precondition can pass;
- qualification VM admission (370's stage), with the 4 GiB `MemoryMax` inside its 10 GiB cap;
- base pin `9c44836d…5e53f`.
