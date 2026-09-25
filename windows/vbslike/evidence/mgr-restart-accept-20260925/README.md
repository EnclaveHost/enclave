# The manager's restart recovery on real Hyper-V: two failures, the diagnosis, and a pass (2026-09-25)

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Times are box-clock log lines.
- Package: enclave-63's v32 at `pkg\071f194b86a573ac\`: the a44bb55a IGVM (launch digest `58DFEBFE…`), `guest\runtime.json`
  (RuntimeID `ccadb38a…`), and hello-world's `spawn.json` (policy memMiB 128).
- No `vbslike-host.exe` ran in any of these runs. The manager starts no wmiserve yet, so they say nothing about launcher
  `15338081`.
- Each run was bounded by `manager-accept.ps1`: the run lock, a clean-start refusal, a watchdog, and a temporary
  AllowFirmwareLoadFromFile restored to Absent (verified each time).

**This is lifecycle and recovery evidence. It is not isolation evidence: host_excluded=no, and no report or chain exists.**

## The pass: run 080420 (tree `windows/isolation-manager` 3b1ee4d8, 20 files hash-verified on the box)

[pass-080420/driver.out](pass-080420/driver.out), verbatim:

    PASS A0: inventory ready and empty; no manager-owned VM on this host
    PASS A1: POST 201 in 8486 ms, id hv02980fc1f4210caa5784bc4c69f56e8b, status starting, partition wmi-openhcl-gen2-igvm-linux, hostExcluded false
    PASS A2: 1 VM(s) carry id hv02980fc1f4210caa5784bc4c69f56e8b: enclave-app-hv02980fc1f4210c-9c3d10f1 1b4a1b33-2933-411b-91d8-a16c2b5d8c85 Running
    PASS A3: manager gone; the VM is Running
    PASS A4: GET 200: recovered true, status starting, appReady false, relay null, hostExcluded false
    PASS A5: second POST 409 naming hv02980fc1f4210caa5784bc4c69f56e8b; VMs with this id 1, manager-owned VMs 1
    PASS A6: DELETE 200; VMs with this id 0; GET after 404
    N/A A7: the relay dies with the manager - no per-domain wmiserve relay exists yet (enclave-5d's wmiserve-run.mjs)
    RESTART-ACCEPT ALL PASS (N/A: A7)

**What this establishes, on the real manager process and real Hyper-V:**
- A catalog spawn defines, starts and names ONE type-1 partition, with its identity in the VM's Notes. The VM gets
  2048 MiB from a 128 MiB policy (`8799941c`).
- Killing the manager, abruptly, leaves the VM running.
- A new manager process recovers the VM from its Notes as `recovered:true`, `starting`, with no relay. It refuses a
  second spawn for the same deployment with 409, naming the recovered id, and no second VM appears.
- It removes the VM by VM Id, and the id then answers 404.
- The restart fixes 53672cbe, 6b1137ee and 8aac6cb4, until now tested only against fakes, hold on hardware for
  this case.

**Not established:**
- the relay dying with the manager (A7, N/A until wmiserve runs per domain);
- the node's side of the hold (5d's node code, not exercised here);
- anything about the app serving;
- anything about isolation.

## The two failures, and why

Runs 075126 and 075544 used tree `8e6cefa5`, then `b0c43b68` for the driver. Both failed A1, and every later check
failed because no VM existed. The launcher's own reason ([fail-075544/driver.out](fail-075544/driver.out)):

    reason "the VM is Running but the guest produced no output on \\.\pipe\enclave-app-hvd5ae1997daaf21-9c3d10f1-com1 within 25s: a silent partition is not a booted one"

- **The partitions DID boot.** Each run's archived guest-state copy differs from the master, which only a booted
  paravisor writes. Hyper-V logged "started successfully" and nothing about a boot failure.
- **The same launcher code passed from the canary,** twice: with the old policy ([diag/lc-policy128.txt](diag/lc-policy128.txt)
  shows the catalog policy, so VM size is not the factor), starting in about 6.2 s.
- **Diagnosis:** the canary's runner delayed the console reader by 4 s, with the launcher itself unchanged
  (`ca265b7d`). It then failed with the SAME error ([diag/lc-delay4000.txt](diag/lc-delay4000.txt)). The monitor
  prints its boot lines once, about 3 s after Start-VM. The launcher attached its reader from a new PowerShell process
  after Start-VM returned, and in the manager's path it attached too late.
- **Fix (`3b1ee4d8`):** `CMD.startAndRead` starts the VM and reads the console in ONE process. The reader begins
  connecting (`ConnectAsync`) BEFORE Start-VM and falls back to an in-process retry straight after it. Run 080420 is
  that fix on hardware.

Found by this run's own evidence: the manager's `reason` field was not printed by the first driver, which now prints
it (`b0c43b68`).
