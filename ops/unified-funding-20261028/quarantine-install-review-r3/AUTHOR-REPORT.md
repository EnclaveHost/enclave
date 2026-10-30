# quarantine-install-repair-r3: report (SOURCE ONLY)

Nothing was executed: no Python, no tests, no systemctl, no SSH, network or production access. The only tools available were Read, Grep and Write. Every test outcome below is **expected, not observed**. Root must review the code and run the bounded tests before using it.

Original artifacts were not touched. These remain unchanged:
- `../quarantine-install-prep-r2/*`
- `../quarantine-install-root-review-r2/*` (the frozen candidate plus root's two failing tests)

## Files
- **`quarantine_install_r2.py`** is a corrected copy of the prep-r2 installer.
  - The module name is unchanged, so root's `test_root_adapter.py` imports it as is.
  - Production pins are unchanged: `483b1c5e…` plus the four unchanged modules, the protected set, `457e8647…` and gate helper `1fa1385b…`.
- **`test_quarantine_install_r2.py`** uses an owned temp root and `FakeHost`. FakeHost is a unit-test adapter only.
- **Root's regressions:** run `../quarantine-install-root-review-r2/test_root_adapter.py` unchanged against this directory, for example with `PYTHONPATH=<this dir>`. By reading the code, both should now pass.

## Changes
### 1. Gate adapter (`SystemdHost.gate_status`, `_require_gate`)
**Helper output, read from the pinned source:**
- `inspect` prints `{routesSha256, etag, gateIds, upstreams}`.
- `status --op` prints `{phase, ownedGateExact, gateAbsent, routesSha256, matchesBefore, etag}`.
- These come from two **separate** reads of the routes.

**Adapter fixes:**
- It now reads `routesSha256`. If that field is missing or not hex, it refuses with `gate-helper-shape`.
- Helper failures or timeouts now refuse with `gate-helper-failed` instead of producing a raw traceback.

**`_require_gate` requires all of the following:**
- `phase == "gate-verified"`, `ownedGateExact is True` and `gateAbsent is False`.
- `gateIds == ["session-write-gate-<op>"]`.
- The plan's `gate.hash`/`gate.etag` match the inspect read.
- The status read's `routesSha256`/`etag` equal the inspect read's.

The plan's `gate.hash` must now be 64-character hex.

### 2. Stop authority after start (`_bind_candidate`, `_fail_after_start`)
**When the installer may stop anything:**
- `_seen` is set only by `_bind_candidate`. That runs only after `systemctl start` **returned normally**, and the binding is recorded as `candidate-bound`.
- Binding requires every one of these:
  - a new InvocationID that is neither the prior one nor the old one
  - pid+ticks that are not the old ones
  - a loaded ExecStart exactly equal to the wrapped original, with the pinned EnvironmentFiles list
  - `/proc` cgroup equal to the unit cgroup, and the pid listed in that cgroup
  - `/proc/<pid>/exe == /usr/bin/node`
  - environ `INVOCATION_ID` equal to the unit's
  - both flags in force
  - candidate sources and the owned drop-in in place
  - stable ticks

**Cleanup:**
- Stop is allowed only if the current `{pid, startTicks, invocationId, controlGroup, environSha256}` equals the binding and the loaded launch config is still the wrapped one.
- **Start raised (e.g. a timeout) or binding never completed:** records `failed-unknown-retained-manual-reconciliation` with `manualReconciliationRequired: true` and raises `candidate-unbound-not-stopped`. Nothing is stopped and the gate and marker stay.
- **Bound, but the invocation was replaced before cleanup:** records `failed-ambiguous-retained-manual-reconciliation`. Nothing is stopped.

### 3. Pre-exec quarantine guarantee
**The drop-in** (`dropin_bytes(op, exec_argv)`) now contains no `Environment=` lines. It only does this:
```
[Service]
ExecStart=
ExecStart=/usr/bin/env SESSIONS_WRITE_QUARANTINE=1 SESSIONS_FUNDING_INTAKE=0 /usr/bin/node /opt/nan-relay/api-relay.js
```
- Systemd builds the environment (Environment=, then EnvironmentFiles), then execs `/usr/bin/env`.
- `env` overrides the two keys and execs the unchanged original argv.
- So the two values are in the runtime's envp at `execve`, before any relay code runs, whatever an EnvironmentFile says.
- The original EnvironmentFiles, admin settings and other Exec* lines are left untouched.

**Pins:**
- `Pins.exec_argv` holds the original argv. `Pins.environment_files` holds the nine paths in their order, with `ignoreErrors` true only for host-sponsor. Both come from root's read-only properties; no contents are included.
- Argv tokens are restricted: no whitespace, `%`, `$`, `;`, quotes or backslashes.
- The plan gains a strict `launch: {wrapperSha256, runtimeSha256}`. The plan schema is now `…-plan-v3` and the snapshot schema `…-snapshot-v3`.

**What each snapshot records:**
- The loaded ExecStart and EnvironmentFiles from `systemctl show`.
- Streamed digests (sha256, size, mode, uid, gid) of `/usr/bin/env` and `/usr/bin/node`. These binaries are hashed, not copied.
- Private 0600 copies of every EnvironmentFile that exists, plus its sha256, size, mode and owner. Absent files are recorded as absent.

**`_require_launch` runs at four points:**
- preflight (loaded config must be the original)
- after daemon-reload (must be exactly the wrapped config, which catches a later-sorting drop-in that resets ExecStart)
- immediately before start
- after start

**At each point it requires:**
- Wrapper and runtime are root-owned, not group/world-writable, and pre == post == current == plan.
- Each EnvironmentFile is pre == post == current (bytes, size, mode, owner, presence), was not changed during the copy, and is present unless `ignoreErrors` is set.

**Post-start checks still in place:** full environ diff (original + exactly the two keys) and the immutable quarantine probe.

### Not done (secondary, per instructions)
- Root note 4 (fstat stability after `FS.read`) was not reworked. The only exception is that the new `FS.digest` checks size, mtime and ctime after its read.
- Parent directory permissions are not changed or asserted.

## Tests (unexecuted)
- **Pre-exec quarantine, using FakeHost's model of systemd plus `env`:**
  - With a plain Environment= drop-in, an EnvironmentFile containing `SESSIONS_WRITE_QUARANTINE=0` wins. With the wrapper it does not.
  - Changing an EnvironmentFile after the stop is refused before any start. Covered changes: flags appended, mode changed, an ignored file appearing, a required file removed.
  - An EnvironmentFile swapped *after* the last pre-start check still gives the runtime `1`/`0` at exec. The bound candidate is then stopped on `environment-file-drift`.
  - A later-sorting drop-in that resets ExecStart is refused after reload, before start.
  - Wrapper or runtime bytes or mode drift is refused.
- **Stop authority:**
  - A start timeout with a new, plausible invocation running is not stopped.
  - Four unbound identity variants are not stopped.
  - A bound candidate replaced by a concurrent restart is not stopped.
  - Env drift, a bad probe, or a journal written after start each stop only the bound candidate.
  - A failed start with nothing running is recorded as such.
- **Gate:** tests use the helper's exact output shapes through the real `SystemdHost.gate_status`. A disagreement between the inspect and status reads is refused.
- **`ActualHelperShapes`** imports the pinned `session_gate.py` source and runs its own `main()` with `read_routes`, `api`, `secure_dir` and `load` replaced in-process. It is skipped if the file is absent; override the location with `SESSION_GATE_SOURCE`. It includes `test_source_matches_production_pin`. I could not compute that file's hash, so **if this test fails, the source at that path is not `1fa1385b…`**, and root must reconcile it.
- **Carried over from prep-r2 and adapted:** drift, gate, marker, snapshot, lock, schema, crash and rollback, temp files, and CLI tests.

Run with `python3 -m unittest test_quarantine_install_r2` in this directory.

## Open items for root
1. **`parse_show` is unqualified.** The ExecStart text shape (`{ path= ; argv[]= ; ignore_errors= ; … }`) and the EnvironmentFiles shape (`/path (ignore_errors=yes|no)`, one line each) are assumed from systemd's show format. Compare them with live read-only output. Anything that does not parse exactly is refused.
2. **Binary paths must not be symlinks.** `/usr/bin/env` and `/usr/bin/node` must be regular files. `/proc/<pid>/exe` must read back exactly `/usr/bin/node`. A symlinked node is refused, which is safe but may need a decision.
3. **Plan values root must supply:** `launch.wrapperSha256` and `launch.runtimeSha256`, from read-only hashing. `gate.hash` is now the helper's `routesSha256`.
4. **An unbound candidate is left running.** An unbound but running process, including one where the flags are somehow not in force, is not stopped by design. The Caddy gate stays in place and manual reconciliation is required.
5. **Residual race:** a concurrent admin `systemctl restart` between our start returning and the binding cannot be told apart from our own start. Both use the same pinned launch config, so both run under quarantine.
6. **Prep-r2 open items 1–9 still apply**, except the gate field-name item. That includes the window between the helper pin check and the helper call.
