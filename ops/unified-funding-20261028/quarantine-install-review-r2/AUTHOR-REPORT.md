# quarantine-install-prep-r2: report (SOURCE ONLY)

Nothing was executed: no tests, no Python, no systemctl, no SSH, network or production access. The only tools available were Read, Grep and Write. All test results below are expected outcomes that root still has to confirm. Root must review before running anything; `--apply` against `/` has never been run.

## Files
- `quarantine_install_r2.py`: the library and CLI.
  - Pure validation: `validate_plan`, `env_problems`, `parse_env`, `dropin_bytes`, `quarantine_probe_ok`.
  - `FS`: maps an explicit root, refuses symlinks, writes through exclusive temp → fsync → readback → link/rename (CAS) → directory fsync.
  - `Installer`: `snapshot`, `apply`, `rollback`, `inspect`.
  - `SystemdHost`: the PRODUCTION adapter, still unqualified.
- `test_quarantine_install_r2.py`: 21 tests. About 150 lines are fixture code. They use an owned temporary root and `FakeHost`, which is a unit-test adapter only and proves nothing about production. Run with `python3 -m unittest test_quarantine_install_r2` (not yet run).

## The one forward transition (`apply`)
Every check below must pass, and nothing is written until they all do:
1. **Service stopped, confirmed directly:** `inactive`/`failed`, `MainPID=0`, and both the old and current cgroups have no PIDs. The installer checks this itself and does not rely on a stop record.
2. **Old process gone:** identified by PID + start ticks + boot ID. A reused PID number with different start ticks counts as a different process.
3. **Lock and gate:** the exclusive operation lock is acquired with flock (non-blocking). The gate must be `gate-verified` with `ownedGateExact`, and its hash/ETag must exactly match the plan (CAS).
4. **Bound evidence:** the hold marker must contain `{op, phase:"financial-hold", baseline, preStopSnapshotSha256}` and match its pinned hash. The stop record and checkpoint evidence must match their hashes and be bound to the same op and baseline. They are never evaluated as coverage.
5. **Snapshots:** the private pre-stop and post-stop snapshots must match their manifest hashes and read back correctly, including the 0600 `environ.bin`. The post-stop snapshot must be bound to the stop-record hash.
6. **No drift:** the 4 protected sources, the 5 targets, and the unit plus all 10 drop-ins must match across the plan, pre-stop, post-stop and current state. No extra drop-in may exist. Every financial state file must equal its post-stop copy. The 5 staged files must be owned, not group/world-writable, and match their pins. Production pins are `483b1c5e…` plus the four unchanged modules, which the CLI cannot override.
7. **Plan:** the plan must match its pinned hash, use a strict schema (unknown keys such as `coverageVerified` are refused), be fresh, use a new op (the closed op is refused), and have no previous `install-r2` record.

Then it runs these phases, each recorded durably in `state.json` with fsync+rename:
1. `sources-installing` → `sources-installed`. Five modules are installed; `sessions.mjs` is replaced by CAS against `457e8647…`, and absent modules are created without replacing anything.
2. `dropin-written`. One additive drop-in with exactly `SESSIONS_WRITE_QUARANTINE=1` and `SESSIONS_FUNDING_INTAKE=0`.
3. `reload-unknown`. `daemon-reload`, then `DropInPaths` must be the original set plus ours.
4. Fresh re-checks of stop state, gate, marker and financial state.
5. `start-unknown`. One `systemctl start`.

The candidate is then verified:
- Its invocation must be new and its PID/start ticks must not be the old ones.
- `/proc` cgroup must equal the unit's `ControlGroup`.
- Environment: the only allowed difference from the original is the two added keys, plus value changes in five systemd per-invocation variables.
- The quarantine status probe must show `value:"1"` and `persisted:false`. A `GET /funding/config` response is never treated as activation.
- The relayer journal must be unchanged, and the sources, gate and marker must still be in place.

Success phase: `quarantine-running-gate-retained`, recorded with `writesResumed`, `intakeEnabled`, `originalStarted` and `coverageEvaluated` all false.

## Failure, rollback and inspect
- **Failure before start:** recorded as `failed-before-start-retained`. Files and leftover temp files are kept and nothing is started.
- **Failure after start:** the installer stops the unit only if the running invocation is verified as its own candidate (new InvocationID, environment's `INVOCATION_ID` and cgroup match, same identity it saw earlier). Result: `failed-candidate-stopped-original-stopped`. Otherwise it records `failed-ambiguous-retained` and stops nothing. It never starts the original and never touches the gate, marker or journals.
- **Rollback** is a separate command and needs the exact `state.json` hash plus a stopped service. It restores `sessions.mjs` from the pre-stop copy (CAS), removes only modules and the drop-in that exactly match what was installed, then runs `daemon-reload`. It never starts anything and always records `launchPermitted:false`. It never touches financial state.
- **`inspect`** is read-only. It returns the phase, state hash, facts, history, snapshot hashes and any leftover `.qr2.tmp` files.

## Test coverage
Each required case maps to a test:
- Active old writer and residual cgroup/identity.
- PID reuse.
- Drift in sources, protected files, stage, symlinks and drop-ins.
- Environment drift after start.
- Missing or stale gate.
- Missing or tampered marker.
- Missing snapshot manifest, `environ.bin` or a copied file.
- Crash after the drop-in, and crash partway through installing sources.
- Interrupted temp file left in place.
- Wrong candidate identity, three variants: reused invocation, foreign cgroup, old PID+start ticks. None of them is stopped.
- Probe not showing immutable quarantine, and intake-off rules.
- Journal changed after stop (refused), and journal written after start (kept as is, never restored).
- After any failure, the original stays stopped.
- Lock already held, strict plan schema, CLI root policy, and no secrets in output.

## Open items for root
1. **`SystemdHost` is unqualified.**
   - The output fields of `session_gate.py` `inspect`/`status` (`hash`, `etag`, `phase`, `ownedGateExact`) are assumed. The helper's pin `1fa1385b…` is checked before it is called, but there is a small gap between that check and the call.
   - The quarantine probe polls readiness at most 6 times, 5 s apart.
   - Timeouts: show 15 s, reload 60 s, start 210 s, stop 220 s, helper 30 s.
2. **Lock hand-off:** the installer takes `activation.lock` itself. If the persistent driver from the runbook already holds it in another process, the installer refuses. Root needs to decide how the lock is handed over.
3. **Marker format:** the runbook's watchdog `activation-started.json` has a different shape from the marker this installer requires. Root must write or qualify a bound marker; nothing creates one automatically.
4. **Index file after start:** the quarantined process may still update the index file through GET and tick handling, so after start only the relayer journal is checked.
5. **Candidate stop:** `systemctl stop` acts on the whole unit, not one invocation. The invocation is verified just before the stop, but there is a small window in between.
6. **Pre-stop snapshot:** this is a non-atomic copy of live files. Any file that changed during the copy is recorded with both hashes (`changedDuringCopy`).
7. **Retrying an op:** a preflight refusal writes nothing, so the same op can be retried while the plan is still valid. Once `install-r2/` exists, the op can never be rerun.
8. **Owner controls:** the drop-in does not wire owner controls or any economic manifests. Owner-write relay routes are quarantined anyway, and owners can still act directly on-chain.
9. **CLI exceptions:** the CLI turns refusals into JSON output. Other exceptions, such as malformed JSON or OS errors outside the recorded install phases, still exit with a Python traceback. Tracebacks contain no environment values.

Out of scope and still required: stop observation, checkpoint-coverage qualification, nonce-tail reconciliation, gate removal, and every decision to resume writes or intake.
