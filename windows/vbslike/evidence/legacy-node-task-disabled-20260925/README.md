# The retired legacy node's boot task is DISABLED (persistently, reversibly)

**Why.** Steven's standing direction is "We should only be using Our new isolation implementation", so the retired
legacy node must not restart by itself. Its boot task `\EnclaveWindowsNode` would have re-run it at every boot:
- U4 showed this; for that one test boot it was disabled and then re-enabled (enclave-5d's call);
- enclave-5d flagged the unplanned-boot case to Codex/Steven;
- Codex then asked d1 to disable the task.

**This is not** a new production-hosting authorization, a legacy-engine restore, or a reboot.

**Box clock:** 15:56:31Z-15:56:32Z, 2026-09-25, on nucbox-k11 (boot of 15:38:44Z).

## What was inspected first (read-only, 15:55:31Z)

- The task `\EnclaveWindowsNode`: principal SYSTEM (ServiceAccount, Highest), ONE action
  `"C:\Users\claude\vbs\node\run-node.cmd"` with no arguments, ONE trigger `MSFT_TaskBootTrigger` (a 1-minute delay).
  Its last run was 2026-09-25 05:33:55Z (boot 68), result 0x1.
- `run-node.cmd` loads the legacy node's own config (`node-config.cmd`; not read, since it may hold keys), changes to
  `C:\Users\claude\vbs\node\` and runs `node agent.mjs >> agent.log`. It launches nothing else, so the task serves no
  unrelated purpose.
- No other scheduled task, service or Run key references `vbs\node`.
- Not running: no legacy node process, no ee-host, no VMs, no harness.

## The change

`Disable-ScheduledTask -TaskName EnclaveWindowsNode -TaskPath \`. Nothing else. The task is NOT deleted.

## Verified after (15:56:32Z, `disable.log.txt`)

| Check | Result |
|---|---|
| state | `Disabled`, `Settings.Enabled = False`; persistent: it is in the task definition |
| definition | the only difference is the added line `<Enabled>false</Enabled>` (`EnclaveWindowsNode.xml` → `EnclaveWindowsNode.after.xml`) |
| ACLs | the task file's SDDL and the TaskCache registry security descriptor (sha256 `96261ff1…`) are unchanged |
| other tasks | of 266 tasks, the ONLY state change is `\EnclaveWindowsNode` Ready → Disabled |
| legacy node | last run still 05:33:55Z; legacy node processes 0 |
| unchanged | Secure Boot on; staged v40 `15f39ae4…` and the v39 rollback `61028ec3…`; VMs 0; no reboot |

## Rollback

`ROLLBACK.txt`; the full backup is on the box in `C:\Users\claude\d1-legacy-task-backup-20260925-155629\`.
- To re-enable exactly as before: `Enable-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\'`. Re-enabling
  does not run the task; its boot trigger would start the legacy node at the next boot.
- If the definition were lost: re-register it from the backup XML. Its export must hash to `b8ea54d3…`.

In the public copies here, the machine SID in the ACL strings is masked as `S-1-5-21-<machine>`; the full values are
in the on-box backup.
