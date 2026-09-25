# The live-neighbour probe, first run (093326, 2026-09-25): printed PASS, RE-JUDGED INCONCLUSIVE

enclave-d1, nucbox-k11, boot 68, Secure Boot ON. Box-clock log lines. Log:
[uefi-dev-boot-20260925-093326.log.txt](uefi-dev-boot-20260925-093326.log.txt).
- Image: `a44bb55a` from v35 (initrd `680d40fa`, domprobe `0d12e950`, which has no TPM opens).
- Script: `uefi-dev-boot.ps1` at `5929d313`, with `-Bundle hello-world -ProbeNeighbor`.
- The neighbour was served by wmiserve = the box's `target\release\vbslike-host.exe` `0160d835`, NOT the package
  launcher `435717de` (enclave-63's correction). That binary is also the report signer in this run.
- AllowFirmwareLoadFromFile and the 9001 service were restored and removed (verified), and the VM was removed.

**What held (observed):**
- **The layout.** The neighbour is domain 1 on guest port 40001; the probe is domain 2 (uid 5002).
- **The neighbour was live BEFORE and AFTER the probe.** The relay returned the pinned bytes `03ba204e…`, and the
  monitor's own `list` showed domain 1 with the bundle's AppID `9c3d10f1…`. So it survived the probe.
- **The probe's own view.** own_app=READABLE (6 bytes), which is the positive control that the view is its own chroot.
  2 visible pids, 1 signalable, done printed.
- **Memory CONTAINED, with positive evidence.** It touched 48 MiB of its 64 MiB cap, then `DOM2 ERROR runtime exited
  status=137` and `MON domain 2 ended`.
- **Nothing forbidden was reached.** No READABLE, CONNECTED, OPENED, CREATED or ENXIO.

**Why the printed PASS does not stand** (enclave-99's review of 5929d313, applied by the judge at `judge-probe.tests.ps1`,
which re-judges this run's recorded lines as INCONCLUSIVE):
- **The file routes** (other_app_*, other_front_socket): ENOENT shows only that the path is absent from domain 2's view.
  Nothing in this build states that `/domains/1/app.wasm` or `/domains/1/run/front.sock` exist in the root namespace;
  that is the source's word. So it is not a neighbour denial. The relative and escape routes resolve to the absolute one
  inside a chroot and are not independent.
- **vsock to CID 1** (vsock_local_domain1/2, vsock_own_control): `Network is unreachable` is NO IN-GUEST ROUTE for
  anyone on this build. The guest kernel (363b3553) has `CONFIG_VSOCKETS_LOOPBACK=m`, `vsock_loopback.ko` is not in the
  initrd, and dominit never loads it. So CID 1 falls to hv_sock, which allows only CID 2. It is neither denied nor
  broken.
- **vsock_host_control** timed out: a host connection was ATTEMPTED from inside the domain, and nothing listens at host
  port 9000. That is no service, not a denial. (An open question is recorded below.)
- **report=refused** came while the signer (`0160d835`) was running. It signs only apps it loaded, and the probe's
  artifact was not loaded by it. That is a launcher-side rule, not cross-domain evidence, and not signer authorization.

**Open question (hypothesis, for enclave-5d and 99):** the timeout suggests a domain CAN open an hv_sock connection to
the host. The launcher's report service on host port 9001 checks the calling VM, not the calling domain. In a VM that
holds several domains, could a domain ask the host signer directly to sign a report for another loaded app? This is not
tested. It needs a domprobe route aimed at 9001 during a serving run.

**Verdict: INCONCLUSIVE.** The observed containment is real. Neighbour denial is not established on this build. PASS needs
a stat-only, root-namespace existence statement for each file target, and a positive control for any vsock route.
host_excluded=no.
