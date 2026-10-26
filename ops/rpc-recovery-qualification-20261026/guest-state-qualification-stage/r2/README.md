# guest-state-qualification-stage/r2: root-run real qualification Q1–Q3 (source only; r1 preserved unchanged)

**PREPARED, NOT RUN.**
- Claude ran no test, build, network, sudo, SSH, VM or queue action. **No test or qualification result is claimed.**
- The RPC VM is off. Root plans a separate small qualification VM (8 GiB, L1 off), owned by Claude370's `rpc-qualification-vm-stage`. That stage is **not edited** here, and its plan is not yet written.
- Q2 keeps the candidate's own `MemoryMax=4G`, which is within that plan's 10 GiB cap.
- The install candidate (`guest-state-install-stage`) is not edited and not imported; it is consumed only via root sha256 pins.

**Changes vs r1** (from root's Q2 source review, false-PASS risks):

| r1 risk | r2 |
|---|---|
| `systemd-analyze verify` rc and `base --version` rc recorded but ignored | Both are **preconditions**. A non-zero rc, or empty version output, refuses (rc 2) before any scratch side effect. |
| An empty or malformed fixture map could give a vacuous PASS | The map must be **exactly** 11 entries: the positive control `good` plus 10 hostile families. The 10 are `abs-path`, `traversal`, `symlink-write-through`, `symlink-relative`, `hardlink-abs`, `hardlink-rel`, `extra-file`, `device-node`, `outside-db` and **new `setuid-bits`**. Each must carry its exact expectation, and `goodOutputs` must be exactly the 4 declared paths. Each fixture's tar members are read **in memory** (`zstd -dc` → `tarfile` listing; nothing unpacked) and must equal `fixtures.json`. |
| `TimeoutExpired` gave rc "timeout" ≠ 0, so a hostile case PASSed | A case can qualify **only** from transient-unit evidence that the pinned binary ran: systemd-run's summary (`Finished with result` + `Main processes terminated with: code=exited/status=N`) **and** the binary's own `Extracting local archive` line (reth `extract.rs:346`). Never qualifying: a client timeout, no summary (launch failure), status 200–245 (systemd exec setup failures such as NAMESPACE, SECCOMP or EXEC), a signal or `RuntimeMaxSec` kill, an unparsable status, or a missing marker. |
| The unit could still run during inspection | Each case uses a **fresh unique transient unit name**, which must not pre-exist (never adopted). Before any inspection or the next case, the unit must be inactive/failed with `MainPID` 0, or unloaded. If it is still active, ONLY that unit is stopped and re-verified. If it cannot be verified stopped, the run **ABORTS** (rc 3): no further cases and no inspection or cleanup while a writer may live. |
| README implied Q2 ran the helper | **Corrected:** Q2 runs the **pinned base binary directly** (`snapshot download --url file://` → tar 0.4.46 unpack) under the candidate's sandbox. **Q2b**, the candidate's own `guest_state.py extract-stage` inside its real unit, is a **separate** later step once the candidate is frozen. |

**Fixture expectations:**
- `good`: `extracted-exact`;
- 9 families: `refused-or-confined` (the pinned binary refuses, or the staging is not exact and install's exact-set check refuses);
- `setuid-bits`: `refused-or-neutralized`. tar 0.4.46 masks header modes `& 0o777`, so stripping the bits with an otherwise exact staging is also safe.
- **In every case:** the decoy and the rest of the scratch dir must be byte-identical and the datadir metadata unchanged; otherwise it is an ESCAPE (FAIL).

**Sandbox identity (unchanged rule):** every `[Service]` property of the frozen candidate extract unit is passed to `systemd-run` verbatim, except the reviewed substitutions:
- `ExecStart` → the extractor argv;
- `ReadWritePaths` → `<scratch>/stage <scratch>/x-home`;
- one added bound, `RuntimeMaxSec`.

`--quiet`/`--collect` are no longer used, so the summary is the evidence. Failed transient units stay loaded as evidence until root runs `reset-failed`.

## Files
| file | role |
|---|---|
| `host/make_fixtures.py` | The 11 fixtures (format `…fixtures/r2`, structured members). Python ≥ 3.8 + the `zstd` CLI; the decoy must be under `/srv/enclave-base-holder/tmp/gsq-r2/`. |
| `guest/q1_b3sum.py` | Unchanged logic from r1 (b3sum `1.2.0-1` provenance + KAT; fail closed). |
| `guest/q2_extract_confinement.py` | **Rewritten** as above. Exit: 0 all 11 PASS; 1 fail/inconclusive; 2 precondition refused; 3 aborted. |
| `guest/q3_guard_inspect.py` | Unchanged logic from r1 (read-only; guard by hand; never starts retention). |
| `host/run_in_guest.sh` | Unchanged logic: per-file copy with sha check, hard timeout, `@REM@` placeholder. |
| `test/test_q2_logic.py` | **19 mocked logic tests** (systemd, base, zstd and sha256 mocked) for each false-PASS path. **NOT native qualification.** |
| `jobs/root-q2-logic-tests.sh` | Root job: exactly 19 tests, bare `OK`. |

## Q2 procedure (root, inside the qualification VM, through the queue)
1. **Choose the run name:** `RUN=/srv/enclave-base-holder/tmp/gsq-r2/<run>`, which must not exist yet.
2. **Generate fixtures** on the host with `python3 host/make_fixtures.py --out <dir> --decoy $RUN/decoy`, and pin the `fixtures.json` sha256.
3. **Install the frozen candidate files** at the paths its unit references, so that `systemd-analyze verify` can pass. It is a precondition and fails closed.
4. **Run the logic tests** (`jobs/root-q2-logic-tests.sh`); they must PASS 19/19. This qualifies only the decision logic.
5. **Run Q2:** `host/run_in_guest.sh q2 --timeout=8000 --fixtures=<dir> -- --candidate-unit <frozen unit> --candidate-unit-sha256 <pin> --base-bin /opt/enclave-rpc/bin/base --base-bin-sha256 9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f --fixtures-dir @REM@/fixtures --fixtures-json-sha256 <pin> --scratch $RUN`.
   - **Bound:** 11 × (`--case-timeout` 300 + 60) s, plus up to 60 s stop verification each.
   - **Outputs:** `$RUN/q2-result.json`, `$RUN/logs/<case>.log` (systemd-run output + the unit's journal) and the host `logs/q2-<id>/`.

Q1 and Q3: as in r1 (see the r1 README). Q3 pins the retention unit `f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee`; the drop-in pin is a root input.

## Exact root inputs (not invented)
- the frozen candidate extract unit path + sha256, and the drop-in sha256;
- the `fixtures.json` sha256 after generation and the run name;
- the Q1 result reviewed into `gsi.env`;
- qualification VM admission and capacity (Claude370's stage; root coordination);
- base binary pin `9c44836d…5e53f` (existing).

## Not covered
- Any native result.
- Q2b (the helper inside its real unit).
- Q4 (the real install).
- Whether every candidate property is accepted by `systemd-run -p`. A rejection means the unit never runs, so the case is classified `setup` and FAILs; it never PASSes.
- systemd output formats on noble's systemd 255 are taken from source knowledge. An unanticipated status format is classified `unclassified` and FAILs; it never PASSes.
