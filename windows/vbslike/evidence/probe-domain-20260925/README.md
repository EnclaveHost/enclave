# The in-domain adversary probe on the measured type-1 guest (a44bb55a), on Hyper-V: run 091717 (2026-09-25)

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Box-clock log lines. Script `uefi-dev-boot.ps1` at `c16d785d`, with
`-LinuxDirect -IsolationType 1 -VbsOptOut -ProbeDomain`. There was no app. The image is `a44bb55a` from enclave-63's v35.
AllowFirmwareLoadFromFile and the 9001 service were restored and removed (verified).

**What was run.** After MON ready, a PROBE-mode domain was loaded RAW over hv_sock 9000:
`{"cmd":"load","label":"PROBE","size":6,"cpu":50,"mem":64,"probe":true}` plus the 6-byte artifact. Its workload is the
measured `/plat/domprobe`, which stands in for a compromised runtime and reports what it could reach. The domain's
public `mode` still reads `serve`; the probe flag is private, and domexec's `started adversary probe` line shows it was
honoured.

**COM1, verbatim** ([uefi-dev-boot-20260925-091717.log.txt](uefi-dev-boot-20260925-091717.log.txt)):

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

**What this establishes, on this guest and host (app-versus-app containment inside the partition, by the guest
kernel):**
- **An unprivileged domain.** It runs as uid 5001, not root.
- **No reach into another domain.** Its files are not reachable by an absolute, relative or escaping path, nor is its
  front socket.
- **No report interface.** The report-interface files (configfs tsm, sysfs) are absent, and no tsm entry can be
  created.
- **Almost no process visibility.** It sees 2 pids and can signal 1: its own.
- **No other channels.** No vsock route to another domain, to its own control port or to the host answers, and the host
  gateway is unreachable.
- **Memory is capped.** The domain was killed (137) at its 64 MiB cap after touching 48 MiB: contained, not
  UNCONTAINED.

**Expected and recorded as not passing:** `dev_tpm0` and `dev_tpmrm0` are MISSING. This image's domprobe predates
that control, which is in candidate `b7ba7731` (review `fd92d610`). Its canary runs this same step, and those two lines
must read `No such file or directory`.

**What it does not establish.** Anything about the HOST: this is containment between domains inside the guest.
host_excluded=no. `report=refused` is expected here: no report signer (wmiserve) was running in this run.

**The mechanism, and two dry runs.** Runs 091020 and 091408 read NOTHING after the load. The COM1 client is
disconnected after the ready wait on every run; G4 had to re-attach too. The probe block now re-attaches (`c16d785d`),
and 091717 is the first run with it.
