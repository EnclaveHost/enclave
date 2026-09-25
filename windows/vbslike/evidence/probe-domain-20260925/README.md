# The in-domain adversary probe on the measured type-1 guest (a44bb55a), on Hyper-V: run 091720 (2026-09-25)

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Box-clock log lines. Script `uefi-dev-boot.ps1` at `c16d785d`, with
`-LinuxDirect -IsolationType 1 -VbsOptOut -ProbeDomain`. There was no app. The image is `a44bb55a` from enclave-63's v35.
AllowFirmwareLoadFromFile and the 9001 service were restored and removed (verified).

**What was run.** After MON ready, a PROBE-mode domain was loaded RAW over hv_sock 9000:
`{"cmd":"load","label":"PROBE","size":6,"cpu":50,"mem":64,"probe":true}` plus the 6-byte artifact. Its workload is the
measured `/plat/domprobe`, which stands in for a compromised runtime and reports what it could reach. The domain's
public `mode` still reads `serve`; the probe flag is private, and domexec's `started adversary probe` line shows it was
honoured.

**COM1, verbatim** ([uefi-dev-boot-20260925-091720.log.txt](uefi-dev-boot-20260925-091720.log.txt)):

    MON domain 1 loaded label=PROBE ... port=40001 uid=5001 cpu=50% mem=64MiB mode=serve http=0
    MON refused report request from uid 0 (not a domain)
    DOM1 report_as_root=refused
    DOM1 started adversary probe=2 (no app, no front)
    PROBE1 uid=5001 euid=5001
    PROBE1 other_app_absolute=No such file or directory
    PROBE1 other_app_relative=No such file or directory
    PROBE1 other_app_escape=No such file or directory
    PROBE1 other_front_socket=No such file or directory
    PROBE1 own_app=READABLE (6 bytes)
    PROBE1 configfs_tsm=No such file or directory
    PROBE1 sysfs=No such file or directory
    PROBE1 create_tsm_entry=No such file or directory
    PROBE1 visible_pids=2
    PROBE1 signalable_pids=1
    PROBE1 report=refused
    PROBE1 vsock_local_domain1=Network is unreachable
    PROBE1 vsock_local_domain2=Network is unreachable
    PROBE1 vsock_own_control=Network is unreachable
    PROBE1 vsock_host_control=timed out (no answer)
    PROBE1 own_loopback_8080=Connection refused
    PROBE1 host_gateway=Network is unreachable
    PROBE1 done
    PROBE1 eating memory: cap 64 MiB, will try 256 MiB
    PROBE1 memory_touched=48 MiB
    DOM1 ERROR runtime exited status=137
    MON domain 1 ended: its process tree exited

**CORRECTED 2026-09-25 (independent audit of 3c3dce3d): what this run does and does NOT establish.**

The probe was loaded as domain 1, and NO other domain was running. domprobe hard-codes its "other domain" targets to
domain 1 (`/domains/1/app.wasm`, `/domains/1/run/front.sock`, vsock ports 40001 and 40002). In this run those targets
were the probe's OWN domain or nothing at all. So the ENOENT and connection failures below are observations of what the
probe's own view lacks. They are NOT denials against an existing, live neighbour.

Observed namespace and resource containment (valid as observations):
- the workload runs unprivileged (uid 5001);
- its filesystem view is its own chroot: the listed host-root paths are absent from it, and its own `/app.wasm` is
  readable;
- its pid namespace shows 2 pids, and it can signal 1;
- its network namespace has no route to the QEMU-style gateway, and vsock is unreachable from it;
- its memory cgroup cap was enforced: it was killed (137) at 64 MiB after touching 48.

NOT established by this run:
- **Denial against another app:** no live neighbour existed, and the hard-coded targets were its own or absent.
- **Enforcement versus no service:** `vsock_host_control=timed out` means nothing answered. It is not a denial.
  `host_gateway` 10.0.2.2 is a QEMU address with no target on Hyper-V.
- **The report interfaces:** configfs_tsm, sysfs and create_tsm_entry are absent from the domain's view. Whether they
  exist in the guest's root namespace on this VBS path was not shown.
- **Signer authorization:** `report=refused` came with NO report signer (wmiserve) running, so it says nothing about
  signer authorization. `DOM1 report_as_root=refused` is the monitor refusing uid 0, a monitor-side check.
- **The TPM device:** dev_tpm0 and dev_tpmrm0 were MISSING here (this domprobe predates them). Even when present,
  ENOENT will show only absence from the domain's view unless the device's existence in the root namespace is also
  shown.

The live-neighbour acceptance that replaces the "other app" claim is being built: a normal domain 1 serving the
pinned hello-world fixture, verified through its legitimate route before and after, then the probe as domain 2 against
those exact live targets. A missing, dead or wrong target fails; a timeout is inconclusive. See PROOF-CHECKLIST.

**The mechanism, and two dry runs.** Runs 091020 and 091408 read NOTHING after the load. The COM1 client is
disconnected after the ready wait on every run; G4 had to re-attach too. The probe block now re-attaches (`c16d785d`),
and 091720 is the first run with it.
