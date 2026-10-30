# bootstrap-systemd-canary-stage/r3: the guest systemd canary for the r13-final bootstrap units (PREPARED; NOT run on the guest)

r3 = r2 (`c5e83747`, kept unchanged) + ONE runner fix: the host runner's PROCESS exit is the combined result (an original failure is kept; a guest rc 0 exits 22 when the validated HOST-VERDICT is not pass, 21 when the owned stop/cleanup failed); `host_verdict.py` exits non-zero unless pass. r2 superseded frozen r1 (`e11886a9`). **Gate:** `FINAL-PINS.json` stays null until r13-final's ACTUAL qualification.
- **While pins are null,** `tools/assemble_canary_bundle.py`, the host runner and the guest script all refuse.
- **To fill them,** root fills the stage path, its `SHA256SUMS`, the five files' shas and the `guest/canary_units.py` sha. Then root re-freezes r2 (the runner verifies its own `SHA256SUMS`).

## Run (root, after r13-final qualifies)
Run through the shared queue:
```
python3 -u ../claude-test-queue.py --mib 512 --log bootstrap-systemd-canary-stage/r3/logs/root-systemd-canary.guard -- bash bootstrap-systemd-canary-stage/r3/jobs/root-systemd-canary.sh
```
The host runner, adapted from `guest-original-game-canary-stage/jobs/root-original-game-canary.sh`, does the following:
1. **Assemble and upload:** builds the upload from the FILLED pins and uploads it with bounded sizes (16 MiB) and timeouts.
2. **Run the guest script** over ssh with a hard timeout (2400 s).
3. **Watch the PHYSICAL host's memory.** A HOST `/proc/meminfo` watchdog runs every 5 s. Its flag is created BEFORE the loop and its PID is captured; only that PID is waited on or killed. Below 16 GiB it stops ONLY `enclave-sdcanary-<ID>-*.service`, never the VM or a production unit.
4. **Clean up on EVERY exit**, including a partial setup:
   - stop the canary's own units;
   - fetch `result.tar` and the diagnostics;
   - run the owned guest `cleanup.sh`;
   - write `HOST-VERDICT.json`.
5. **The host verdict PASSes only** with all of:
   - runner rc 0;
   - guest `## systemd-canary rc=0`;
   - guest `verdict.json` pass;
   - at least 2 readable host samples, all at or above 16384 MiB;
   - no breach record.

**The guest script** sees the GUEST's (64 GiB VM) meminfo. It therefore guards only a **guest reserve** (4096 MiB), with the same race-free sampler and an EXIT trap armed before setup, and stops only its own units. This guest reserve is **not** the host floor.

## What a PASS proves (on the guest's real systemd, with the r13-final bytes; reviewed code executed from those bytes)
1. **Root phase.** The release-mode sandbox is the live holder unit's sandbox plus the r13-final drop-in. In it:
   - euid 0, the handshake env and exactly the drop-in bounding set;
   - rpcbase files can be read (DAC_READ_SEARCH);
   - journal dir and lock-FILE ReadWritePaths work, with the reviewed wrapper's `release_launch_lock`/`launch_lock`/`_secure_path` really taking the flock;
   - EROFS elsewhere, and InaccessiblePaths are denied;
   - the reviewed `own_datadir` chowns a private root file (CAP_CHOWN);
   - the legacy-mode refusal.
2. **Own L1 is ready from INSIDE that sandbox:** the reviewed `holder_gate.wait_l1` passes, bounded at 300 s, using the r13-final wrapper's `l1-ready`. This is **REQUIRED**: a sandbox that cannot reach its own L1 cannot start the holder, so the canary fails.
3. **Reviewed privilege drop + execve:** rpcbase only, no capabilities, `setuid(0)` fails, correct writes and denials.
4. **Busy refusal:** with the REAL snapshot download active, the reviewed `datadir-idle` ExecCondition skips the start. If the download is not active, this is **NOT EXERCISED** (stated, never claimed).
5. **Permit → holder `Requires`/`After` order:** a failed permit is re-run first, and a permit that keeps failing blocks the holder. This uses a **MOCK permit**.
6. **Reproof RuntimeDirectory:** root 0755, `publish_status` writes 0644, and Preserve carries both into the next unit. A private name is used.
7. **Invariants:**
   - production PIDs and states unchanged;
   - production unit files and `/etc/enclave-rpc` metadata unchanged;
   - the guest reserve held, with real sampler evidence;
   - the HOST floor held, with real host watchdog evidence.

## What it does NOT prove
- **Not the holder itself:** no real holder start; no wrapper `run('base')`, coverage/blob gates or launch journal consume; no node, release exec or real datadir.
- **No real `/run/enclave-rpc`** name.
- **No real permit or harness.**
- **Differences from production:** `Type=exec` and the 28G/25G limits are replaced by oneshot and 512M.
- **Not exercised:** cold-boot ordering after a reboot, and `IPAddressDeny` enforcement.
- **Not verified offline:** systemd 255 transient support for every `-p` property. A rejected property is a canary FAILURE, not a pass.

## Offline tests (`jobs/root-offline-tests.sh`, shared queue 512, `unshare -Urn`): 17 (r2's 14 + r3: guest rc 0 with < 2 host samples -> exit 22 + HOST false; guest rc 0 with no fetchable result -> 22; cleanup failure after a passing run -> 21, and a prior guest failure (3) is kept)
| Class | Tests | What they check |
|---|---|---|
| Render (real inputs) | 2 | — |
| Wrapper code | 2 | The flock is really held (a second taker is busy); legacy and env-less starts are refused; extraction refuses code needing an undeclared global |
| Guest sampler | 3 | Real bash functions with a fake systemctl and meminfo. Flag before loop; samples taken; the reserve stop targets own units only; only our PID is killed (an unrelated process survives). The EXIT trap after a partial setup leaves no orphan and stops own units. An early `main` failure touches no unit |
| Host runner | 5 | The REAL runner from a private stage copy, with a fake ssh guest and fake host meminfo: success requires host samples; a host floor breach stops only own units and is never a pass; an upload failure after staging still cleans up; a guest timeout or guest failure is a failure with cleanup; null pins refuse before any guest contact |
| Verdict | 2 | L1, guest reserve and PID evidence are required; the host verdict needs ≥ 2 samples, the floor, rc 0 and a guest pass |
