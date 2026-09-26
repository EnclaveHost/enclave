# Host-reboot acceptance, PRODUCTION configuration (the NucBox hv node, after test 1 passed R4)

U4 proved restart behaviour in the LAB only. This proves it on the production install: the two hv tasks, the v42 package,
and the node from main with RESTART RECOVERY (main fa4284db or later: enclave-87's ruling (B) and its amendment). enclave-d1
executes every box step; the workstation half is read-only. Written by enclave-5d; reviewed by d1 and b4.

## What must happen (enclave-87's ruling)
After a graceful host reboot, with no operator action:
1. `\EnclaveHvManager` and `\EnclaveHvNode` come back (boot +30 s, +90 s), from the installed files.
2. The launcher defines every VM with AutomaticStartAction Nothing, so test 1's partition is Off. The restarted manager
   lists it `recovered` (vmState Off), and it is NEVER served.
3. The node RETIRES that VM through the manager (confirmed gone) and starts ONE fresh partition inside the same lease:
   a NEW instance, a NEW transport key, nothing released on chain, never a second VM. A held lease is not renewed while
   held.
4. The relay row re-attaches, with the attested boot counter +1.
5. Public TLS returns: `https://<id8>.app.enclave.host/` answers 200 "Hello" on the NEW key.
6. Secure Boot is still ON, and the legacy task `\EnclaveWindowsNode` is still present and Disabled.
Deadline: 15 minutes from the boot. Anything later, or any operator action needed, is a FAIL.

## Preconditions (d1 checks each; any "no" stops here)
- **No other box step is running.** `C:\Users\claude\uefi-probe.lock` is free (no lab or acceptance run holds it). No
  canary or lab manager is running, and no VM carries the manager's Notes tag other than test 1's:
  `Get-VM | ? Notes -like 'enclave-vbslike-app-domain*'` lists exactly one. No install or rollback is in progress.
- **Everything else on the box is accounted for:** `Get-VM` (all), and the running scheduled tasks
  (`Get-ScheduledTask | ? State -eq Running`). Anything not ours (e.g. a RISC Box VM) has its owner's OK for a reboot.
- **The node is the production install from v42** (the node from main at or after fa4284db; `run-node.cmd` names that
  tree). Without restart recovery, test 1 would stay held.
- **Test 1 passed R4 on its current partition** (`hvnode-accept-remote.sh <id> <key>`: all PASS).
- **The lease will outlive the reboot:** the ledger's `leaseUntil` for test 1 is at least 30 minutes away (the node
  renews at 15 minutes). A lease that lapses during the reboot takes the claim path instead, which is a different test.
- **Gas:** the operator holds at least 0.0005 ETH, and latest nonce = pending (R3).
- **Authorization:** enclave-87's go for this reboot, recorded with its time.

## Evidence BEFORE
1. Box: `hvnode-accept.ps1 -Commit <c> -DeploymentId <id>` (read-only: no `-KillRecovery`, no `-OwnerRestart`): all PASS.
2. Box: `hvnode-reboot-capture.ps1 -Phase pre -DeploymentId <id> -OutDir C:\Users\claude\vbs-like\hvnode\reboot-<UTC stamp>`.
   It records the boot time, Secure Boot, the three tasks, the tagged VMs, the manager's record (instance and transport
   key), the node's /availability, and the log line counts. It FAILs unless the deployment runs on exactly one partition.
3. Workstation: `hvnode-accept-remote.sh <id> <transportKeySha256>`: all PASS. Keep the R1 INFO line (verifiedAt and
   bootCounter) and R3 (gas, nonce). Also keep the ledger's `leaseUntil`, `balance6` and `runner` for the id.

## The reboot (box, d1)
`shutdown.exe /r /t 60 /d p:0:0 /c "enclave hv-node reboot acceptance"`: a graceful, planned restart, abortable for 60 s
with `shutdown /a`. Record the time (read, UTC). Nothing is stopped by hand first: the point is the production path.

## Evidence AFTER (within 15 minutes of the boot)
1. Box, once both tasks are Running: `hvnode-reboot-capture.ps1 -Phase post -DeploymentId <id> -OutDir <the same dir>`.
   It JUDGES against the pre capture, exit 1 on any FAIL:
   - the host rebooted;
   - Secure Boot ON; the legacy task Disabled;
   - both hv tasks Running;
   - exactly ONE tagged VM, Running, and the pre-reboot VM gone from Hyper-V;
   - ONE manager record for the id: running, not recovered, a NEW instance on a NEW transport key;
   - the node registered, owner-only, isolation advertised, tier hv-node;
   - node.log shows `<id10> restart recovery: the recovered VM <old> (Off) was retired; starting ONE fresh partition`,
     with NO `renewed <id10>` before it, and no reboot-recovery HOLD.
   It prints the new transportKeySha256. If a check is not yet true, re-run it (read-only) until the 15-minute deadline.
2. Box: `hvnode-accept.ps1 -Commit <c> -DeploymentId <id>`: all PASS (A4's gas figure is INFO for the node's first 12
   minutes).
3. Workstation: `hvnode-accept-remote.sh <id> <new transportKeySha256>`: all PASS, and R1's bootCounter = the pre value + 1,
   with a verifiedAt later than the reboot. The ledger: the same runner (nucbox-k11), a live lease, NO release
   transaction for the id, and `balance6` moving on.
PASS = all three, within the deadline, with no operator action.

## The manager-only variant (the self-healing half of A8, with test 1 serving)
Cheaper than a reboot, and run first: the same recovery with the VM still Running.
1. `hvnode-reboot-capture.ps1 -Phase pre …` (a fresh OutDir).
2. Kill the manager's node.exe by its exact PID, as A8 does (`MgrProcs` in hvnode-accept.ps1). Its run loop restarts it
   within about 10 s.
3. Expect within 5 minutes:
   - the recovered VM (Running) retired;
   - ONE fresh partition on a NEW key;
   - `restart recovery … (Running) was retired` in node.log;
   - R4 passing on the new key.
   `-Phase post -ManagerOnly` judges it: the host must NOT have rebooted, and every other line is the same, including
   `(Running) was retired` rather than `(Off)`.

## Rollback
- **The tasks did not start at boot:** `Start-ScheduledTask EnclaveHvManager`, wait for `/health` canStart, then
  `Start-ScheduledTask EnclaveHvNode`. Record it: the acceptance FAILED (it needed an operator).
- **The deployment is held** (`isolation: reboot recovery: … held`): an operator's forced relaunch clears it and tries once
  more (`hvnode-accept.ps1 -DeploymentId <id> -OwnerRestart`: a NEW key, so re-run A7 and R4 once). The acceptance FAILED.
- **The node misbehaves in any other way:** `hvnode-rollback.ps1` (nothing serving; nothing deleted). A lease left held
  lapses unrenewed.
- **Secure Boot is off after the reboot, or the legacy task changed:** stop, touch nothing, report to enclave-87 and Steven.
- **The box does not come back:** it needs someone at the machine. Say so at once; there is no remote path.
