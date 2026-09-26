# Canary of the NucBox guest candidate 0891c740 (guest 298924ae), 2026-09-26

**Verdict:**
- Both paths PASS: (i) the dev boot with COM1, and (ii) the manager path with the v42 manager and launcher.
- Kit items 0, 1, 2, 3 and 6 PASS. Item 5 is covered without a box run (enclave-87).
- Item 4 (a probe domain) and the neighbour probe were NOT RUN: the dev-boot script's probe pin table has no entry for this IGVM.
- One format finding (F1), for the kit and soak own-line patterns.

- Run by enclave-d1 on nucbox-k11, with enclave-87's GO. The candidate was handed off by enclave-53.
- Host: Secure Boot ON, legacy backend retired. Each partition's own UEFI Secure Boot is off, as it is for every linux-direct boot.
- Nothing here is an isolation claim: tier T0-hv, host_excluded=no.

## The candidate
| | |
|---|---|
| IGVM | `vbs-linux-candidate.bin` sha256 `0891c740ddf18ded1ea903495b70c799a5cfbe498d05843e47c7b84106ed7998`, 78009052 B, VBS boot digest `A39E2F8C…C817` |
| source | isolation/front-console-guard `298924aebcf6ac5c93d59f3533cb5619215c4d24` (4cdd5169 + 683798d0 + 139c3fdd + d9176ed5 + 298924ae) |
| monitor initrd | `mon-298924ae.cpio.gz` `aaad1d37…` (enclave-53's BUILD.json `7c6803c6…`) |
| on the box | copied to a LAB path, `C:\Users\claude\d1-canary-0891c740\pkg\guest\igvm-vbs\vbs-linux-candidate-0891c740.bin`, hash-checked at every use. `NT VIRTUAL MACHINE\Virtual Machines:(R)` was granted for the run and removed afterwards with `/remove` + `/reset`, leaving the ACL inherit-only again (production/icacls-*.txt). No staged package was changed. |

## Production pause (production/)
The manager-path harness refuses to run while a manager-owned VM exists, so production was paused with the rollout's procedure:
- **02:30:16Z:** hvnode-rollback, with no -Unregister. Test 1's VM hv0261e3f6… was destroyed through the manager, both tasks were Disabled, and 0 VMs remained. The lease was held (leaseUntil 03:04:49Z, balance6 42800).
- **02:51:09Z:** the manager was Enabled and Started (canStart=true), then the node. It printed `renewed 0x31136008` (the lease was still held, so there was no re-claim), then `attach ACCEPTED tier=hv-node`.
- Test 1 respawned on the v40 image b7ba7731 as hv373a3111…, with the new key `619479c8…`. The loopback check returned 200 "Hello World!", and the guest's TLS SPKI equals the manager's key (production/resume.txt).
- The gas guard showed no claim and no price tx.

## Path (i): uefi-dev-boot.ps1 -LinuxDirect -IsolationType 1 -VbsOptOut (path-i/)
The v41 package's control `uefi-dev-boot.ps1` was run with the lab candidate as `-Firmware`/`-FirmwareSha256` and a bundle.
- The script releases COM1 at `MON ready`. The kit's `console-read.ps1` (0bf81e47) then captured the rest of the console in a second session (`*-console.txt`).
- The kit's requests were sent through the lab relay 127.0.0.1:19500 (`*-requests.txt`, which record only status and length).
- `-G4WatchSeconds 100` held the partition, so the requests landed while it served.

| run | bundle | result |
|---|---|---|
| A1 023202 | sentinel SNTLa67d9469ffe1 (2609d1f4) | booted and served; my request helper joined the three paths into ONE request (a `-File` array quirk), so /panic was not exercised. Superseded by A2. Kept for completeness. |
| **A2 023514** | sentinel SNTLa67d9469ffe1 | **PASS**. `/req-1` and `/req-2` got 200 `ok` (2 B); `/panic-3` got 502. Console: `DOM1 ERROR runtime exited status=134`, `DOM1 end`, `MON domain 1 ended: its process tree exited`. The tag appears NOWHERE: not in the console, and not in the dev-boot output with its WMISERVE lines (the one hit is the bundle's file name in the `loading …` line). One line fails the kit's strict own-line regex: see F1. |
| **B 023835** | keep-alive sentinel SNTLkaea192ee7f6 (9a79c076) | **PASS**. `/extra-1` got 200, `HEAD /head-2` got 200, `/req-3` got 200. Console: `DOM front: unsolicited upstream response (147 bytes withheld)` and `(149 bytes withheld)`. The tag appears nowhere, and every console line is MON/DOM. |
| C 024124 | hello-world 1.0.4 (9c3d10f1) + `-ProbeNeighbor` | served EXACTLY the pinned 13 bytes (`03ba204e…`) through the guest's TLS. Neighbour: `NEIGHBOUR ACCEPTANCE: FAIL - the probe build in IGVM 0891c740ddf18ded is not pinned in this script`, a harness pin and not a guest result. NOT RUN (F2). |

**Section 0 on every boot, in the dev-boot script's CONSOLE lines** (which hold the whole pre-ready console, per enclave-bf):
- `MON boundary tier=t0-hv … host_excluded=no hv_isolation=vbs paravisor=no`, then `MON yama ptrace_scope=1 -> 2`, then `MON boot …`, then `MON ready control_port=9000 snp=false transport=hv_sock`.
- Every domain printed `DOM front: not dumpable; none of its 3 threads traced` before `DOM serving`.
- There was never a `traced at start`, `no null device` or `status=126` line.
- `DOM1 started runtime=2 front=3 mode=run http=8000` (this is the normal workload line).
- `DOM runtime wasmtime/48.0.1 execution=jit … id=ccadb38a…` (equal to the package's runtime.json).
- `DOM certificate: no HOST_DATA …; self-signed only` (there is no cert name on this path).
- `DOM serving … ready_ms=2920 / 2895 / 2888`.
- No `DOM release` line anywhere (kit item 3).

## Path (ii): the manager path (path-ii/)
`manager-accept.ps1` was run from the canary tree `C:\Users\claude\d1-canary-252602c8\control`:
- That tree is the v41 control plus the manager files server.mjs `88d855c0`, wmi-launcher.mjs `5971eb8c` and wmiserve-run.mjs `b189c9b8`. These are byte-equal to control v42 90eab896, which is e36f233b's.
- Flags: `-Serve`, the v42 launcher `10547aca…` (d1's reproducible build), `-HvlabScript isolation\m3\hvlab-accept.mjs`, and `-Pkg` set to the lab package. The lab package's runtime.json and hello-world spawn.json/app.bundle are byte-equal to v41's.
- Afterwards the setting was restored and verified, and the tree was unchanged.

| run | result |
|---|---|
| **mgraccept-20260926-024240** | **PASS**: phase 1 `HVLAB-ACCEPT ALL PASS`, phase 2 `RESTART-ACCEPT ALL PASS` (A0-A9, including A8 host turn-off and A9 monitor stop), image `0891c740…` on every spawn. Readiness through the relay: `browser -> tunnel -> app zone -> data plane -> domain`, monitor-signed on the handshake key the manager verified; the app answers on its own name, 200 `Hello World!`. The data plane refuses another key, image, app, runtime and instance. A forced relaunch gets a NEW instance and a NEW key, and the old key is refused. After a node restart the same instance and key are adopted. |
| **mgraccept-20260926-024728** | **PASS** again, the same, plus kit item 6 through the manager's relay (`run2-csr-session.txt`, `run2-enclave-csr.csr.txt`): `GET /.well-known/enclave-csr` returned 200, a PKCS#10 with `subject=CN=4e62e60d.app.enclave.host` and SAN `DNS:4e62e60d.app.enclave.host`. Its self-signature verifies. **Its SPKI sha256 `facd5259…3fcf08` equals the record's transportKeySha256**, so the domain's own TLS key requests the name the manager gave it at load. The record carries `launcherVmId`. |

On this path the console capture got only one 32-byte line, `DOM front: tls handshake error` (F3). So the `DOM certificate: this domain may certify 4e62e60d.app.enclave.host …` console line was not captured here; the CSR is the evidence for item 6.

## Findings
- **F1 (format, not a leak).** Lines the front writes through the std logger keep Go's date prefix:
  `2026/09/26 02:35:48 DOM proxy: GET unreachable`, from ready.go:107's `log.Printf`, with the timeout variant at ready.go:103.
  - consoleFilter keeps that prefix ON PURPOSE on a passing `DOM` line (console.go `logPrefix`/`domLine`). Withheld
    output becomes a date-free class line (`DOM front: tls handshake error`, `… bytes withheld`).
  - The line itself is the front's own: method class only, no path, no tag.
  - But the kit's own-line regex `^(DOM|MON)|^\[ *…\]` and the soak monitor's `CONSOLE_OK` both call it foreign. In the soak, every
    proxy timeout or unreachable would score as a LEAK.
  - Cheapest fix, with no guest change: widen both patterns to also accept `^\d{4}/\d\d/\d\d \d\d:\d\d:\d\d(\.\d+)? DOM `, the same
    form domLine accepts.
- **F2 (harness pin).** `uefi-dev-boot.ps1 -ProbeNeighbor` refuses an IGVM whose probe build is not in its pin table, so the neighbour probe and kit item 4 (`started adversary probe=…`, `"probe": true`) were not run on 0891c740. They need the table entry, from enclave-53's build of the probe. The dev boot does not need a production pause.
- **F3 (capture).** On the manager path, `console-read.ps1` attached after the manager's start-time capture but got one line, and then the pipe closed about 10 s later (`the VM closed its console`, twice). The domain's start lines had already gone by. A per-load console record, or a launcher head that covers up to `until` (enclave-bf's suggestion), would put the section 0 and cert-name lines into the manager's own record.

## Files
- path-i/: `*-devboot.txt` (the dev-boot script's full output, including CONSOLE and WMISERVE lines), `*-console.txt` (console-read after ready), `*-requests.txt`.
- path-ii/: the two harness sessions, the harness's evidence directories (config, driver.out, harness and manager logs), the follow sessions and the CSR.
- production/: the pause, the resume, the ACL grant and removal, and the ledger before the pause.
