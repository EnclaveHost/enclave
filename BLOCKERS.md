# VBS-like isolation on nucbox-k11: the blocker list

One list, kept current. Integration owner: this session (enclave-d1).

## THE BLOCKER, and it is now external

**On this host, the Hyper-V worker ignores `FirmwareFile` and loads the in-box IGVM instead.**
Every run, whatever we set, logs:

> `[Virtual machine <id>] Loading IGVM file from default location.`

and then fails with a bare Worker-Admin event **12030** ("failed to start") carrying no underlying
cause. The in-box image is `C:\Windows\System32\vmfirmwarehcl.dll` (36,177,440 B, 10.0.26100.9457).

**Host:** Windows 11 Pro, 10.0.26200, UBR 9457. `vmwp` 10.0.26100.8457. VM version 12.0 (default and
max). Hyper-V role installed and healthy; `vmms` running.

### What has been ruled OUT, each by measurement

| ruled out | evidence |
|---|---|
| the registry gate | `AllowFirmwareLoadFromFile=1` removes event 5142; without it the worker says the key is missing BY NAME, so it is read |
| file permissions | image copied to `C:\openhcl-probe` with `ReadAndExecute` for `NT VIRTUAL MACHINE\Virtual Machines` on directory AND file, plus the per-VM SID on the file as petri does |
| path traversal | same; and Microsoft's own CI grants on the file only, under `%TEMP%` in a user profile |
| adding the pin AFTER create | petri sets `FirmwareFile` inside `DefineSystem`; done via petri's own `New-CustomVM`, same result |
| `GuestFeatureSet` | 513 (0x201, the reference value), 1024 (what the isolation type sets), and untouched — all identical |
| Secure Boot | on and off, identical |
| the VTL2 address space | reference values `Vtl2AddressRangeSize=1024`, `Vtl2MmioAddressRangeSize=512`, `Vtl2AddressSpaceConfigurationMode=1` (MiB, not bytes — the worker states the 128..1048576 range itself) |
| the image | two different IGVMs, `2d735376` and `7caf7408`, fail identically |
| the historical `vmchipset` crash | zero new `vmwp.exe` faults across every WMI run; that blocker was the HCS path and does not reproduce here |

### Two facts that make this external rather than a configuration error

1. **This build's `Msvm_VirtualSystemSettingData` has no `GuestStateLifetime` property.** Petri's
   reference definition sets it, so Microsoft's own harness definition **cannot be expressed
   unmodified on this schema**. The host is not the one the reference targets.
2. **Hyper-V + OpenHCL + a linux-direct image is untested by Microsoft** (enclave-53, from the
   openvmm source at our pin `a7b0bd4`): petri's Hyper-V backend excluded `is_linux_direct()` in
   `check_compat`, no `hyperv_openhcl_linux` test instance exists at that pin or on upstream main,
   and every Hyper-V OpenHCL case uses the standard UEFI image. Ours is the
   `x64-test-linux-direct` VTL2 recipe with `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux`.

### What would move it, none of which this session can do alone

- **A build that supports it.** The guide names 24H2 (26100.1586+) as having *development* support;
  this host is 26200.9457 and its schema differs from the reference. Establishing which build
  actually honours `FirmwareFile` is the shortest path, and it is a servicing decision.
- **`ohcldiag-dev`** to read VTL2 kmsg over hvsocket. Note our image logs to **COM3**, which petri
  enables only on build >= 27653, so COM1 will never carry OpenHCL's own account of the failure.
  Worth little while nothing of ours is loaded at all.
- **A standard UEFI OpenHCL image** (53's P2) to separate "our linux-direct image" from "OpenHCL on
  this build". Cheap, and it would sharpen the report even though it does not unblock the product.

**A plain HCS partition and a KVM guest are NOT this backend**, and neither may be presented as it.

## Resolved 2026-09-24 21:57Z: the Hyper-V role

Steven authorized NucBox machine reboots. The role is installed and the host is verified:

| | |
|---|---|
| enabled | `Microsoft-Hyper-V` and `Microsoft-Hyper-V-Management-PowerShell`, both with `-All` |
| reboot | requested 21:57:21Z, back 21:57:47Z (boot time), node up 21:59:01Z |
| `vmms` | **Running** (was NOT INSTALLED) |
| `root\virtualization\v2` | `Msvm_VirtualSystemManagementService` present |
| `FirmwareFile` field | present on `Msvm_VirtualSystemSettingData` |
| `Get-VM` | present |
| `VirtualMachinePlatform` | still `Enabled` — the existing enclave's dependency, untouched |
| node bytes | unchanged: `170a0db0…`, `d2595f35…`, `6ec96d19…` |

**A correction worth keeping.** `HYPERV-ROLE.md` named the three leaf features and enabling them
failed: *"One or several parent features are disabled."* `Microsoft-Hyper-V-Hypervisor` and
`-Services` sit under the parent `Microsoft-Hyper-V`, and `-Management-PowerShell` under
`Microsoft-Hyper-V-Tools-All`. The fix is `-All` on the two parents, which pulls the leaves in. The
plan was wrong about the feature tree and right about everything else.

`preflight()` through the real PowerShell runner now answers `ok:true` with all five checks passing,
and `verifyImage()` confirms `openhcl-ownguest.bin` at `2d735376…`, 124,962,164 bytes.

## The blocker

**1. Nothing on the Windows node asks the manager to run anything.** *(now OWNED and started: the
client is `windows/node/isolation-client.mjs` at `261e5f03`, 13 tests, additive and unwired so the
live ef1b2077 baseline is unchanged. What remains is the `ensureApp` hook behind a default-off flag
and the guest-certificate chain.)* Found by enclave-99 by reading
the deployed bytes: neither `windows/node/deployed/*.mjs` at `ef1b2077` nor this branch's
`windows/node/host.mjs` contains any `/vms`, `VMMGR`, `vmReq` or `guestd-control` client.
`supervisor.js` — the consumer the manager was written against — runs on the Linux node CVM, not
here. So after the reboot a partition can boot, and no deployment will ever cause one to.

This is a true serve blocker and it outranks everything below, because the boot probe proves the
host can run a domain while this decides whether an app ever reaches one. **Who writes the Windows
node's `/vms` client is unassigned.** It is not mine to assign; it is the next thing to decide.

## Contract defects found by review, being fixed

enclave-99's `review/nucbox-manager-tests` is the specification; 15 of 18 tests fail against
`8327498e` by design. Fixing in this order:

1. **The spawn body the supervisor actually sends** is refused by `refuseUnsupported()` — it never
   sends `isPublic` or `hasSecrets`, so every real spawn 400s. My own test invented a body the
   supervisor never sends, which is why 77 tests passed over a contract that cannot execute.
2. `backend-hcs.mjs` destroys by LABEL, not by the `id` the load answer carried; `lab.rs` parses it
   with `s.parse::<u32>()` and answers `invalid digit found in string`, which `.catch` swallows —
   so after a hash mismatch the partition stays live and the manager forgets it.
3. `#next()` drops a timed-out waiter while the answer still arrives, desynchronising every later
   command. The protocol has no request ids, so the client needs a FIFO that consumes the late
   answer and marks it failed.
4. `spawn()` drops `boundary`, `tcpPort`, `domainId`, `guestPort`; `health()` has no `boundary` at
   all — losing exactly the word the backend's own header says must never be lost.
5. `remove()` answers `200 ok` and deletes the record while the VM or partition may still be live.
6. A duplicate `id` overwrites the record and forgets the first handle; no `409`.
7. **Fixed.** `survey()`/`teardown()` used `Get-VM -ErrorAction SilentlyContinue`, so a host without
   the module read as a host with no VMs — an empty survey and a *clean* teardown over an orphan
   they could not see. Measured on this box before the role existed. Both now refuse: unenumerable
   is an error, not an empty success. Four tests, and they fail against the old code.
8. **Fixed.** `windows/vbslike/verify/judge-hv.mjs` was the stale ABI/1-only copy, which rejects
   every document from 5d's current image on the binding. Replaced with `67762434`'s ABI/2 copy,
   which folds the runtime identity into the binding via the shared `checkRuntime`.

## The view shape, agreed with 5d and 99

Conform to guestd's contract exactly rather than inventing one: `201` with the record, `status` in
`starting|running|failed` (not `state`), `name` = the deploymentId, `recordSha256`, `409 {error,id}`
on a live name. Ids are the manager's own (`hv` + 8 hex); the supervisor's `gd[0-9a-f]{8}` adoption
regex is a supervisor-side coupling 5d will widen. **Do not fake guestd ids.**

`running` ONLY under the readiness rule: the document verified on THIS handshake's key with a fresh
nonce AND `enclave-ready` 200 on the same key. Never from console bytes. The seam is
`ready.mjs: judgeRunning({host, port, appId, launcherKey, expectRuntime, deadlineMs})`, and 99's
five readiness tests are its acceptance.

## Not blockers, stated so nobody waits on them

- Security proof. Boot first; tests and hardening follow the working path.
- The `vmchipset.dll` crash on HCS isolated starts — the unsupported path.
- Attestation format `hyperv-vbs-partition-v1`, to be defined against a real report.

## The no-role HCS path: a development vehicle, not the target

`backend-hcs.mjs` runs one Hyper-V child partition per app with no role. An HCS child partition does
**not** exclude the host; the guest says so itself (`boundary tier=t0-hv partition=hcs-child
host_excluded=no`) and the backend carries that word up. Nothing it runs may be advertised as
eligible, verified or host-excluded capacity, and a plain HCS boot is not completion.

## Live service, kept separate from all of the above

Six apps. The node runs the deployed bytes recorded at `ef1b2077`, NOT this branch's
`windows/node/` — shipping those puts it into owner-only scope. Do not run `sync.sh`.
