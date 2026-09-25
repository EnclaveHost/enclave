# G4 on hardware: a type-1 partition whose monitor dies goes OFF (run 082856, 2026-09-25)

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Times are box-clock log lines. Log:
[uefi-dev-boot-20260925-082856.log.txt](uefi-dev-boot-20260925-082856.log.txt).

**The question.** The guest kernel has `CONFIG_PANIC_TIMEOUT=-1` and `PANIC_ON_OOPS=y`, so when PID 1 (the monitor)
dies, the kernel panics and asks for an immediate reset (enclave-5d's correction of the earlier G4 premise). What
Hyper-V does with that on a TYPE-1 partition decides how the manager and node must treat a domain whose monitor dies.

**Inputs:**
- The image is enclave-63's PROBE `72462737…` (launch digest `CF339BC5…`), from v33 `pkg\69262a44e7e13901\`: a44bb55a's
  recipe with the initrd `e3b68c92` = `680d40fa` + `/probe.ko` (g4panic, which panics 120 s after load).
- My byte review is `7ce0a5fa`. The probe is never eligible and never serves: this run had no `-Bundle`.
- Script: `uefi-dev-boot.ps1` at `a3f13797`, with `-LinuxDirect -IsolationType 1 -VbsOptOut -G4WatchSeconds 330`.
- AllowFirmwareLoadFromFile was restored to Absent (verified), the 9001 service was removed (verified), and the VM was
  removed.

**Measured** (verbatim excerpts):

    08:29:24 FIRST OBSERVABLE: Start-VM ACCEPTED the partition (state now Running)
      CONSOLE: [    0.319260] MON PROBE G4: armed, this guest will panic on purpose in 120 s (panic_timeout=-1)
      CONSOLE: MON boot 8acd91a83114a02883d575527056e971
      CONSOLE: MON ready control_port=9000 snp=false transport=hv_sock
    08:31:26   G4 CONSOLE: [  121.848959] MON PROBE G4: panicking ON PURPOSE after 120 s: the path a dead PID 1 takes (panic, then panic_timeout)
    08:31:26   G4 CONSOLE: [  121.850243] Kernel panic - not syncing: G4 probe: deliberate panic standing in for the monitor's death
    08:31:26   G4 RESET OBSERVED: uptime fell from 122s to 0s (state Running)
    08:31:27   G4 VM state: Off (uptime 0s)
    08:34:57 G4 RESULT: 1 'MON boot' line(s) [8acd91a83114a02883d575527056e971], 1 arming line(s), 1 'Kernel panic' line(s), 1 uptime reset(s), 1 COM1 re-attach(es), final state Off
      G4 ADMIN [18590] 08:31:26 ... has encountered a fatal error. The guest operating system reported that it failed with the following error codes: ErrorCode0: 0x0, ErrorCode1: 0x8100000606570000, ...
      G4 ADMIN [18515] 08:31:26 ... was shut down for a reset initiated by the guest operating system.

**What this establishes, on this host and build:**
- **The panic happened as designed.** The probe's panic fired 121.8 s after boot, and the kernel printed its panic and
  backtrace on COM1. `panic_timeout=-1` is confirmed from the running kernel.
- **The crash was reported.** Hyper-V recorded the guest crash (18590, from the crash MSRs).
- **The partition turned Off.** Hyper-V answered the guest-initiated reset by SHUTTING THE PARTITION DOWN (18515), and
  the VM went Off within a second. It did NOT reboot: there was one `MON boot` line in 330 s, and there was no wedge.
- **So on type 1, a monitor death ends the domain and turns its partition Off.** Nothing restarts it, and no second
  boot exists to confuse a stale id. The G1 check across a real reboot therefore had nothing to run on.

**Consequence, acted on:** wmiserve does not exit when its VM stops, so the manager's relay-exit watch would never
fire, and the record would read `running` over a dead partition. The manager now runs a liveness sweep
(`windows/isolation-manager` `d7d4fd1c`). It fails any domain whose VM is not Running, stops its relay, reclaims its
sessions, and leaves the VM for the node to retire. It is in the box tree `windows/hv-acceptance` `8a7ffd3e`, 443/443.

**Not established:**
- the sweep on hardware (next serving run);
- the Rust launcher's own `rebooted:true` path, which has no WMI caller and, on type 1, no reboot to meet;
- anything about isolation (host_excluded=no).
