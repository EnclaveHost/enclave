# nucbox-k11, measured facts (independent review lane, enclave-99)

Read-only, from this workstation over `ssh minipc-zt`, with the manager's own modules at 8327498e run from a private
directory (`C:\Users\claude\review-99\manager`, `box-probe.mjs`): no port bound, nothing created, nothing under
`C:\Users\claude\vbs` touched. Raw answers: `box-probe-2026-09-24T2155Z.json`.

## 2026-09-24 21:47Z (survey) and 21:55Z (the manager's own preflight)

| fact | value |
|---|---|
| node bytes running | `host.mjs` 170a0db0…, `agent.mjs` d2595f35…, `appzone.mjs` 6ec96d19… = the deployed copies recorded at ef1b2077; written 21:19:29Z; node pid 936 since 21:19:33Z, ee-host pid 4824; task `EnclaveWindowsNode` Running |
| Hyper-V features | Hypervisor, Services, Management-PowerShell all **Disabled**; VirtualMachinePlatform **Enabled**; HypervisorPlatform Disabled |
| services | `vmms` NOT INSTALLED; `vmcompute` Running; `hvhost` Running |
| WMI | `root\virtualization\v2` "Invalid namespace"; `Get-VM` absent |
| WMI launcher preflight (real PowerShell) | ok=false; missing: vmms service, root\virtualization\v2, Hyper-V PowerShell module, Msvm_VirtualSystemSettingData.FirmwareFile; hypervisor present=true |
| guest image | `C:\Users\claude\vbs-like\openhcl-ownguest.bin` sha256 2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3, 124,962,164 B; `verifyImage()` accepts it against that pin |
| manager `/health` (WMI backend) | canStart=false, cannotStart=the prerequisites, derivations `["enclave-catalog-bundle/1"]`, no `boundary` field |
| one spawn through the real backend | state `failed`, reason "the Hyper-V role is not usable on this host: missing …", **no `attestation` field**; `survey()` before and after: `{"vms":[]}` |
| HCS dev backend preflight | ok=true (launcher, kernel, initrd present); `host excluded`=false; boundary tier t0-hv, hcs-child, hostExcluded=false, attested=false |
| `vbslike-host.exe` | sha256 6040fc6b4e06c667a00c8e3418eab811c7fbf7d6357432bda8d0fe4852a3fa3d, 1,004,544 B, mtime 2026-09-24T19:51:20Z (the owner's message said "built 11:38"; the file's own time is 12:51 PDT) |
| `wsl-kernel` (VTL0 kernel, bzImage) | sha256 7fe3edb5b5dd2435545f611607b1c80e0cbc0e92b83e0cc0a25c07dc7d5ecddd, 15,876,096 B (= the packager's input for vmlinux 363b3553…) |
| `mon.cpio.gz` (VTL0 initrd, the m3 monitor) | sha256 44abb52b1486dd2aae344e021a0d8049dfb2015d137c22a6e336051c4db5a0cf, 24,008,350 B, mtime 2026-09-24T03:08:23Z (= the only initrd the IGVM reproduces with, per enclave-53) |
| manager on the box | `C:\Users\claude\vbs\manager` ABSENT (not deployed) |

## 2026-09-24 22:05Z, after the owner's reboot with the Hyper-V role (raw: `box-probe-2026-09-24T2205Z-after-role.json`)

The owner reports the reboot requested 21:57:21Z, node up 21:59:01Z, all six apps recovered, node bytes unchanged. Measured
here through the manager's own modules, read-only (no spawn: `PROBE_SPAWN` unset while the owner's own start test ran):

| fact | value |
|---|---|
| WMI launcher preflight | **ok=true**: vmms service, root\virtualization\v2, Hyper-V PowerShell module, FirmwareFile, hypervisor present, all true |
| image | 2d735376…, 124,962,164 B, accepted against the pin |
| `survey()` | `{"vms":[]}`, now a TRUE empty (`Get-VM` exists) |
| manager `/health` | canStart=**true**, no cannotStart |
| HCS dev backend preflight | ok=true |
| launcher, kernel, initrd | unchanged: 6040fc6b…, 7fe3edb5…, 44abb52b… (the box still carries the 44abb52b initrd; the guest lane's 7eb1ded4 with enclave-ready and run mode is not on the box yet) |

Deployment-layout fact (defect 9, sent): `windows/vbslike/verify/judge-hv.mjs` imports `../../../isolation/m2/judge.mjs`,
which imports `../../relay/snp-verify.mjs` and `../contract/runtime.mjs`. The manager's own modules import nothing outside
their directory. So a manager that judges readiness on the box needs those three files at the mirrored repository paths;
the branch's `sync.sh` dropped exactly that mirroring (the ef1b2077 version copied `isolation/contract/runtime.mjs`,
`isolation/m2/judge.mjs` and `relay/snp-verify.mjs`), and the packager's "7 runtime modules" do not include them.

## 2026-09-24 22:13:56Z, the HCS window (approved by the owner): ONE PARTITION, END TO END, on the no-role dev path

`hcs-window.mjs` on the box (`C:\Users\claude\review-99\hcs`), the owner's `backend-hcs.mjs` at 8327498e driving the real
`vbslike-host lab` (6040fc6b…) with the box's kernel 7fe3edb5… and initrd 44abb52b…, the pinned hello-world bundle
(73,228 B, sha256 = AppID 9c3d10f1…). Raw: `hcs-window-2026-09-24T2213Z.json` (and the first attempt, which failed only
in the driver: it connected 7 ms after load and the domain's TLS was not listening yet).

| step | measured |
|---|---|
| launcher ready line | launcherKey (fresh Ed25519 per run), boundary `tier=T0-hv partition=hcs-child isolation=none host_excluded=no signer=launcher-in-root-partition`, initrdSha256 44abb52b…, kernelSha256 7fe3edb5… |
| `start` (create partition, boot, push bundle over hv_sock, monitor hashes it) | **5,344 ms**; domainId 1, relay port 19101, guest port 40001; HASH AGREEMENT real: the monitor's appSha256 equalled the derived AppID (the backend compares and would have destroyed on a difference) |
| TLS on the relay port | accepted on attempt 2, 512 ms after start (attempt 1 at +7 ms: ECONNRESET before the handshake: the domain's front was not listening yet) |
| `/.well-known/enclave-attestation` | 200: tier T0-hv, format hyperv-partition-domain/v1, abi enclave-domain-abi/2, nonce echoed, transportKey == the handshake's SPKI, appSha256 9c3d10f1… |
| judge-hv (ABI/2, launcher key from the ready line, runtime pinned) | **monitor-signed**, no reasons, platform host_excluded=false; the same document under another nonce: **reject** |
| `/.well-known/enclave-ready` | 200 with body `Hello World!\n`: on this initrd the route DOES NOT EXIST and the request reached the APP through the proxy. A readiness rule that reads "200" without the document shape would take the app's own answer for readiness (spec extended: readiness-rule.test.mjs) |
| the app, `GET /` with an `x-forwarded-for` header sent | 200, exactly 13 bytes `Hello World!\n`, sha256 03ba204e50d126e4… (the packager's corrected expectation) |
| stop / teardown | destroyed 1 / removed 0 (the launcher's own accounting) |

What this is: the whole partition path on the box works end to end through the owner's backend on the development
(no-role, host-not-excluded) path: boot, bundle delivery with hash agreement, TLS ending inside the domain, a
launcher-signed document judged on the client's own key and nonce, and the app's answer. What it is NOT: a user-owned
canary. Nothing on the node asked for this partition (the node's /vms client exists only since 261e5f03 and is not
wired into host.mjs), the manager's record contract is still the one defects 1-6 name, readiness needs the newer initrd,
and no relay route or lease touched it. The IGVM (role) path does not boot yet. The owner's controlled comparison through the launcher's own `start()`
(`enclave-boot-cmp-0001`, real host): create works, pinFirmware works (returnValue 0, GuestFeatureSet 513, FirmwareFile
reads back), `Start-VM` works (worker event 18500 "started successfully"), and then the guest never boots (worker event
18603 "failed to boot an operating system", zero bytes on the COM pipe in 45 s); the launcher refused it as "the VM is
Running but the guest produced no output: a silent partition is not a booted one". An earlier 0x80070057 was the owner's
hand-built step sequence, not the launcher. The custom-IGVM milestone is NOT met.
**Correction (owner's report, later the same evening):** the bounded, reversible custom-firmware experiment
(`AllowFirmwareLoadFromFile` set per probe and restored to ABSENT) was ALREADY authorized as part of this deployment
work (`windows/vbslike/evidence/isolated-firmware-approved-2026-09-24.md` records prior approved runs); the owner had
treated it as an open decision and this file repeated that. Run on the WMI path, as the owner reports it: the firmware
gate is PASSED (no event 5142; returnValue 0, GuestFeatureSet 513, FirmwareFile reads back), the partition is genuinely
isolated (creation flags 0x6000040000020 against 0x20 before), the historical vmchipset 0xc0000005 fault did not
reproduce (count unchanged at 24), and the start still fails at [12030] "failed to start" with no reason in Start-VM's
message; the owner is starting via WMI to read the job's ErrorDescription. Setting restored to ABSENT and verified, the
VM removed by exact name, the node's pid unchanged, the six apps identical before and after. (The owner's wrapper had
used `Invoke-WebRequest -SkipCertificateCheck`, absent in Windows PowerShell 5.1, so an earlier before/after app check
reported -1 for all six and could not tell healthy from dead; replaced by curl.exe, with an all-dead baseline now itself
a failure.) None of this is measured by this lane; it is recorded as the owner stated it.
**Later (owner's report):** the GuestFeatureSet hypothesis is dead: a VM created with `-GuestStateIsolationType OpenHCL`
carries GuestFeatureSet 1024 and GuestStateIsolationType 16, and pinning the firmware without touching it fails
identically to overwriting it with 513; the WMI job's error is a bare MessageID 12030 with no underlying cause. The
useful control: OpenHCL isolation with NO FirmwareFile fails with "failed to load IGVM file … IGVM image file: ''", so
the worker does try to load one and this build has no in-box image, while our image produces no load error at all.
Still no vmchipset fault on any WMI run. Cause of the start failure: not yet named.

## What these facts do and do not say

- The WMI path cannot start a partition here, by the host's own answer, and the manager says so rather than pretending.
  That is the single boot blocker (BLOCKERS.md), and its remedy is a role change plus one reboot, which is Codex's call.
- The HCS path can run TODAY with these files; it does not exclude the host (t0-hv) and nothing about it is attested.
- `survey()` answering `{"vms":[]}` on a host with no `Get-VM` is not "no VMs": `Get-VM -ErrorAction SilentlyContinue`
  yields nothing when the command does not exist, so survey and teardown read as clean on a host where they cannot
  enumerate at all (defect 7, low, sent to the owner).
- No SNP, no VMPL, no TEE on this box. Nothing here is "attested" or "verified".
