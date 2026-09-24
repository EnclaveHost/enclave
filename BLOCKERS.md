# VBS-like isolation on nucbox-k11: the blocker list

One list, kept current. Integration owner: this session (enclave-d1).

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

## The custom IGVM: measured, and where it stops

Run through the launcher's own `start()` on the real host, `enclave-boot-cmp-0001`:

| step | result |
|---|---|
| `create` | **works** — a real VM, Gen 2, version 12.0, marker applied |
| `pinFirmware` | **works** — `ModifySystemSettings` returnValue 0, `GuestFeatureSet` 513 (0x201), `FirmwareFile` reads back as `openhcl-ownguest.bin` |
| `Start-VM` | **works** — worker event 18500 "started successfully" at 15:12:07 |
| the guest | **does not boot.** Worker event 18603 "failed to boot an operating system"; no bytes on the COM pipe in 45 s |

The launcher refuses to call that booted, in its own words: *"the VM is Running but the guest
produced no output ... a silent partition is not a booted one."* That is the correct verdict and
the milestone is NOT met.

**A correction to an earlier reading.** I first reported the failure as `Start-VM` returning
`0x80070057, failed to start worker process`, and passed that to both other lanes. That came from a
hand-built step sequence of mine, not from the launcher's path — the controlled comparison shows
the launcher's own create→pin→attachConsole→start starts the VM every time. The real failure is one
step later and is entirely different: the VM starts and the image boots nothing.

**The leading hypothesis, not a conclusion.**
`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\AllowFirmwareLoadFromFile`
is **not set** (`bcdedit` testsigning is already Yes). That is the documented gate on loading a
custom firmware image by path, and it fits the evidence exactly: the pin is accepted into the
settings and reads back, and the image is never loaded, so the VM falls through to firmware that
finds no boot device. A control VM with no pin starts and fails the same way, which is consistent.

**Evidence added since, read-only, no host change** (enclave-5d suggested the test).
`Microsoft-Windows-Hyper-V-Worker-Operational` logs a line per VM that loads one:
`[Virtual machine <id>] Loading IGVM file from default location.` Every such line on this box
belongs to an **HCS** lab partition. There is **no firmware or IGVM load line at all** for
`enclave-boot-cmp-0001` (`4D05C87C-…`) at 15:12:07.

So the WMI-created VM never attempted to load an IGVM. The pin was accepted into the settings and
read back, and the worker then started the VM on stock firmware, which found no boot device and
logged 18603. That is now established.

**CONFIRMED 22:18Z with a second, different image.** enclave-53 built a new IGVM around 5d's
initrd — `7caf7408…`, 124,991,060 bytes — and it fails **identically**: `preflight ok`, VM started
(event 18500), `failed to boot an operating system` (event 18603), and **no `Loading IGVM file`
line at all** in `Worker-Operational`. Two different images, same failure, both before any load
begins.

**This rules out image content as the cause**, and with it my own first hypothesis. I had proposed
that the image was an `openhcl-x64-test-linux-DIRECT` build expecting a kernel and initrd through
LinuxKernelDirect that the VM never supplied. enclave-53 ruled it out twice over:

1. Our own-guest images EMBED VTL0. `openhcl-ownguest.bin.map` places `linux-kernel` at
   0x1000000–0x312e000 and 0x3200000–0x4600000, `linux-initrd` at 0x4600000–0x5ce6000, and
   `manifest-ownguest.json` sets `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux`. Only the VTL2 half comes
   from the `-direct` recipe. They never wanted a host-supplied kernel.
2. More basic, and the reasoning I should have reached from my own evidence: **the worker never
   read the file.** A hypothesis about what is INSIDE an image cannot explain a failure that
   happens before the image is opened. Content can only matter once a load begins.

So the cause is host or VM CONFIGURATION: `AllowFirmwareLoadFromFile`, or some VM setting the
worker checks before it honours `FirmwareFile`.

What is still NOT established is *which* — `AllowFirmwareLoadFromFile` is the
leading candidate and is unset, but nothing yet proves that key is the gate rather than some other
missing setting (the IGVM is an `openhcl-x64-test-linux-DIRECT` image, which expects the host to
hand VTL0 a kernel and initrd through LinuxKernelDirect, and this VM supplied neither).

**Why it is not set already.** Setting it permits Hyper-V to load firmware from an arbitrary file
on this host. That is a host security change, it was not part of the approved HYPERV-ROLE plan, and
the reboot authorization covered the role and machine reboots. It needs an explicit decision.

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
